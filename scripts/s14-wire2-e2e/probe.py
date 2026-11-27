#!/usr/bin/env python3
"""Send a fresh local delivery from a retained report for negative/rollback probes."""
import hashlib
import json
import os
import subprocess
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
import uuid
from local_url import check
endpoint, report_file = sys.argv[1:]
check(endpoint)
subprocess.run([sys.executable, str(Path(__file__).with_name('preflight.py')), 'probe', endpoint], check=True)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
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
    with opener.open(req, timeout=30) as resp:
        status, response = resp.status, resp.read().decode()
except urllib.error.HTTPError as exc:
    status, response = exc.code, exc.read().decode()
print(json.dumps({'delivery_id': new, 'sha256': sha, 'status': status, 'ms': round((time.monotonic()-t)*1000), 'body': response}))
