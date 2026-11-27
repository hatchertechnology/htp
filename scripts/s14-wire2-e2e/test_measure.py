#!/usr/bin/env python3
"""Exercise family explanations and the S05 page-share gate."""
import json
import sqlite3
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('measure.py')


def report():
    keys = ('s02_indexing', 's03_integrity', 's04_structured_data',
            's05_link_graph', 's06_duplicates', 's08_resources')
    family = {'state': 'complete', 'truncated': False,
              'coverage': {'unknown': 0, 'unknown_reasons': {}}, 'items': []}
    rows = [{'category': 'test', 'rule_id': str(i), 'candidates_count': 0,
             'candidates_digest': 'sha256:abc'} for i in range(13)]
    coverage = [{'category': 'test', 'rule_id': str(i), 'candidates': 0,
                 'emitted': 0, 'omitted': 0, 'omission_reason': None} for i in range(13)]
    return {'policy_guidance': {'manifest': rows, 'candidate': {'coverage': coverage}},
            'evidence_families': {'families': {k: json.loads(json.dumps(family)) for k in keys}},
            'request': {'url': 'https://www.kerryhatcher.com/'},
            'pages': [{'url': f'https://www.kerryhatcher.com/{i}', 'is_resource': False,
                       'status': 200, 'content_type': 'text/html', 'links': []} for i in range(20)],
            'evidence_contract': {'observations': [], 'evaluations': [], 'truncated': False}}


def measure(value):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'report.json'
        path.write_text(json.dumps(value))
        return subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True)


class MeasurementTests(unittest.TestCase):
    def test_partial_explanation(self):
        for state, expected in [
            ({'reason': 'section_only'}, False),
            ({'truncated': True, 'omitted_reason': 'family_item_limit'}, True),
            ({'truncated': True, 'omitted_reason': None}, False),
            ({'coverage': {'unknown': 2, 'unknown_reasons': {'x': 2}}}, True),
            ({'coverage': {'unknown': 2, 'unknown_reasons': {'x': 1}}}, False),
        ]:
            value = report()
            value['evidence_families']['families']['s02_indexing'].update(state='partial', **state)
            with self.subTest(state=state):
                self.assertEqual(measure(value).returncode == 0, expected)

    def test_guidance_byte_boundary(self):
        value = report()
        guidance = value['policy_guidance']
        guidance['padding'] = ''
        base = len(json.dumps(guidance, ensure_ascii=False, separators=(',', ':')).encode())
        guidance['padding'] = 'x' * (838860 - base)
        self.assertEqual(measure(value).returncode, 0)
        guidance['padding'] += 'x'
        self.assertNotEqual(measure(value).returncode, 0)

    def test_graph_counts_distinct_direct_page_omissions(self):
        value = report()
        graph = value['evidence_families']['families']['s05_link_graph']
        item = {'kind': 'capture_omission', 'locator': '/pages/0',
                'reason': 'collector_byte_limit', 'facts': {'collector': 'graph'}}
        graph['items'] = [item, item, {'kind': 'deep_page', 'locator': '/pages/1',
                                     'reason': 'collector_byte_limit', 'facts': {}}]
        result = measure(value)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['s05_collector_byte_limit'], 1)

    def test_truncated_graph_uses_worker_capture(self):
        value = report()
        value['request']['request_id'] = 'test-run'
        graph = value['evidence_families']['families']['s05_link_graph']
        graph.update(state='partial', truncated=True, omitted_reason='family_item_limit')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'
            db_path = Path(directory) / 'worker.sqlite'
            path.write_text(json.dumps(value))
            with sqlite3.connect(db_path) as db:
                db.execute('create table local_page_evidence (job_id text, url text, evidence text)')
                for index, page in enumerate(value['pages']):
                    collector = {'collector': 'graph', 'state': 'unavailable' if index == 0 else 'observed',
                                 'reason': 'collector_byte_limit' if index == 0 else None}
                    db.execute('insert into local_page_evidence values (?, ?, ?)',
                               ('test-run', page['url'], json.dumps({'capture': {'collectors': [collector]}})))
            result = subprocess.run([sys.executable, str(SCRIPT), str(path), str(db_path)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['s05_collector_byte_limit'], 1)

    def test_truncated_graph_requires_capture_evidence(self):
        value = report()
        graph = value['evidence_families']['families']['s05_link_graph']
        graph.update(state='partial', truncated=True, omitted_reason='family_item_limit')
        self.assertNotEqual(measure(value).returncode, 0)


if __name__ == '__main__':
    unittest.main()
