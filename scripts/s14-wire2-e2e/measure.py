#!/usr/bin/env python3
"""Measure the §3.4 report gates from exact downloaded wire-2 bytes."""
import hashlib
import json
import sys
from urllib.parse import urljoin, urlsplit

raw = open(sys.argv[1], 'rb').read()
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
    assert f['state'] in ('complete', 'partial')
    assert f['state'] != 'partial' or f.get('reason') or f.get('truncated') or bool(f['coverage']['unknown_reasons'])
pages = [p for p in r['pages'] if not p.get('is_resource')]
seed = urlsplit(r['request']['url'])
external = 0
for p in pages:
    if not (p.get('content_type') or '').lower().startswith(('text/html', 'application/xhtml+xml')):
        continue
    for link in p.get('links', []):
        u = urlsplit(urljoin(p['url'], link['url']))
        if u.scheme in ('http', 'https') and (u.scheme, u.netloc) != (seed.scheme, seed.netloc):
            external += 1
hits = families['s05_link_graph']['coverage']['unknown_reasons'].get('collector_byte_limit', 0)
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
                    'policy_guidance': compact(g) <= 838861, 's01': not evidence['truncated'] and len(evidence['observations']) <= 1024 and len(evidence['evaluations']) <= 1024,
                    's05': bool(pages) and hits * 20 <= len(pages)}
print(json.dumps(metrics, indent=2))
sys.exit(0 if all(metrics['gates'].values()) else 1)
