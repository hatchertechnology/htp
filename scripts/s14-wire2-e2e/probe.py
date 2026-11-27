#!/usr/bin/env python3
"""Send a fresh local delivery from a retained report for negative/rollback probes."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit
endpoint, report_file = sys.argv[1:]
u = urlsplit(endpoint)
if u.scheme != 'http' or u.hostname != '127.0.0.1':
    raise SystemExit('endpoint must be loopback HTTP')
raw = Path(report_file).read_text()
old = json.loads(raw)['request']['request_id']
new = str(uuid.uuid4())
if raw.count(old) != 1:
    raise SystemExit('request ID does not have exactly one occurrence')
raw = raw.replace(old, new)
sha = hashlib.sha256(raw.encode()).hexdigest()
body = json.dumps({'delivery_id': new, 'sha256': sha, 'report_json': raw}, separators=(',', ':')).encode()
req = urllib.request.Request(endpoint, body, {'content-type': 'application/json', 'authorization': 'Bearer ' + os.environ['HTP_INGEST_TOKEN'], 'idempotency-key': new})
t = time.monotonic()
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        status, response = resp.status, resp.read().decode()
except urllib.error.HTTPError as exc:
    status, response = exc.code, exc.read().decode()
print(json.dumps({'delivery_id': new, 'sha256': sha, 'status': status, 'ms': round((time.monotonic()-t)*1000), 'body': response}))
