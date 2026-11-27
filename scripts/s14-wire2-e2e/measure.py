#!/usr/bin/env python3
"""Measure the §3.4 report gates from exact downloaded wire-2 bytes."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import urljoin, urlsplit

if not __debug__:
    raise SystemExit('measurement checks require Python assertions enabled')

with open(sys.argv[1], 'rb') as source:
    raw = source.read()
r = json.loads(raw)
compact = lambda x: len(json.dumps(x, ensure_ascii=False, separators=(',', ':')).encode())
g = r['policy_guidance']
manifest = g['manifest']
coverage = g['candidate']['coverage']
rows = {(x['category'], x['rule_id']): x for x in manifest}
assert len(rows) == len(manifest) == len(coverage) == 13
assert set(rows) == {(c['category'], c['rule_id']) for c in coverage}
for c in coverage:
    m = rows[(c['category'], c['rule_id'])]
    assert m['candidates_count'] == c['candidates'] == c['emitted'] + c['omitted']
    assert not c['omitted'] or c['omission_reason'] in ('record_limit', 'observation_limit')
    assert 'candidates' not in m and m['candidates_digest'].startswith('sha256:')
families = r['evidence_families']['families']
expected = {'s02_indexing', 's03_integrity', 's04_structured_data', 's05_link_graph', 's06_duplicates', 's08_resources'}
assert set(families) == expected
for f in families.values():
    if f['state'] == 'unavailable':
        assert f.get('reason'), 'unavailable family lacks a section reason'
    assert f['state'] in ('complete', 'partial'), 'unavailable family fails the acceptance gate'
    if f['state'] == 'partial':
        cov = f['coverage']
        truncated_reason = f.get('truncated') and bool(f.get('omitted_reason'))
        unknown_reason = cov['unknown'] > 0 and sum(cov['unknown_reasons'].values()) == cov['unknown']
        assert truncated_reason or unknown_reason, 'partial family lacks required coverage reason'
pages = [p for p in r['pages'] if not p.get('is_resource')]
def is_html(p):
    content_type = (p.get('content_type') or '').split(';', 1)[0].strip().lower()
    return 200 <= (p.get('status') or 0) < 300 and content_type in (
        'text/html', 'application/xhtml+xml', 'application/vnd.wap.xhtml+xml')
seed = urlsplit(r['request']['url'])
external = 0
for p in pages:
    if not is_html(p):
        continue
    for link in p.get('links', []):
        u = urlsplit(urljoin(p['url'], link['url']))
        if u.scheme in ('http', 'https') and (u.scheme, u.netloc) != (seed.scheme, seed.netloc):
            external += 1
graph = families['s05_link_graph']
if graph.get('truncated'):
    assert len(sys.argv) == 3, 'S05 items incomplete; supply the worker SQLite capture database'
    uri = Path(sys.argv[2]).resolve().as_uri() + '?mode=ro'
    with sqlite3.connect(uri, uri=True) as db:
        captures = {url: json.loads(value)['capture'] for url, value in db.execute(
            'select url, evidence from local_page_evidence where job_id = ?', (r['request']['request_id'],))}
    html_pages = [p for p in pages if is_html(p)]
    assert all(p['url'] in captures for p in html_pages), 'worker capture evidence incomplete'
    hits = 0
    for p in html_pages:
        graph_collectors = [c for c in captures[p['url']]['collectors'] if c['collector'] == 'graph']
        assert len(graph_collectors) == 1, 'worker graph capture missing or ambiguous'
        c = graph_collectors[0]
        hits += c['state'] == 'unavailable' and c.get('reason') == 'collector_byte_limit'
else:
    hits = len({item['locator'] for item in graph['items']
                if item['kind'] == 'capture_omission' and item.get('reason') == 'collector_byte_limit'
                and item.get('facts', {}).get('collector') == 'graph'})
evidence = r['evidence_contract']
metrics = {'sha256': hashlib.sha256(raw).hexdigest(), 'report_bytes': len(raw),
           'manifest_bytes': compact(manifest), 'policy_guidance_bytes': compact(g),
           'pages': len(pages), 'resources': len(r['pages']) - len(pages),
           's05_collector_byte_limit': hits, 's05_collector_byte_limit_share': hits / len(pages) if pages else None,
           'observations': len(evidence['observations']), 'evaluations': len(evidence['evaluations']),
           's01_truncated': evidence['truncated'], 'out_of_scope_links': external,
           'families': {k: {'state': v['state'], 'reason': v.get('reason')} for k, v in families.items()},
           's14_omissions': [{k: c[k] for k in ('category','rule_id','candidates','emitted','omitted','omission_reason')} for c in coverage]}
metrics['gates'] = {'report': len(raw) <= 3962204, 'manifest': compact(manifest) <= 13107,
                    'policy_guidance': compact(g) <= 838860, 's01': not evidence['truncated'] and len(evidence['observations']) <= 1024 and len(evidence['evaluations']) <= 1024,
                    's05': bool(pages) and hits * 20 <= len(pages)}
print(json.dumps(metrics, indent=2))
sys.exit(0 if all(metrics['gates'].values()) else 1)
