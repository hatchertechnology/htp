#!/usr/bin/env python3
"""Generate the offline FixtureTransport crawl; no network fallback is possible."""
import json
import sys
host = 'https://fixture.example'
resources = int(sys.argv[2]) if len(sys.argv) > 2 else 400
entry = lambda status, mime, body: {'status': status, 'headers': {'content-type': mime}, 'body': body}
responses = {host + '/robots.txt': entry(404, 'text/plain', ''), host + '/sitemap.xml': entry(404, 'text/plain', '')}
for i in range(57):
    assets = ''.join(f'<link rel="stylesheet" href="/r{k}.css">' for k in range(i, resources, 57))
    links = ''.join(f'<a href="/p{(i+j)%57}">page</a>' for j in range(1, 4))
    external = ''.join(f'<a href="https://outside.example/{i}/{j}">external</a>' for j in range(8))
    body = f'<html lang="en"><head><title>Fixture page {i}</title>{assets}</head><body><h1>Fixture {i}</h1>{links}{external}</body></html>'
    responses[host + ('/' if i == 0 else f'/p{i}')] = entry(200, 'text/html', body)
# Links to /p0 must resolve to the home page too.
responses[host + '/p0'] = responses[host + '/']
for i in range(resources):
    responses[f'{host}/r{i}.css'] = entry(200, 'text/css', 'body { color: #222; }')
with open(sys.argv[1], 'w') as f:
    json.dump(responses, f, separators=(',', ':'))
