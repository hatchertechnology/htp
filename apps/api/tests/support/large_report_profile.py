#!/usr/bin/env python3
"""Local-only near-limit HTTP profile; run with the built htp-api lib test binary.

Example: python3 apps/api/tests/support/large_report_profile.py target/.../htp_api-...
Requires Linux systemd user scopes, curl and /usr/bin/time. The mock is a
separate process from the measured API; all data and credentials are synthetic.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

root = Path(__file__).resolve().parents[4]
report = json.loads((root / 'supabase/tests/fixtures/contracts/v2-complete.json').read_text())
# Unknown fields are allowed by the receiver. Many small tokens stress the
# parsed JSON tree rather than only exercising one large scalar allocation.
report['padding'] = [0] * 7_590_000
raw = json.dumps(report, separators=(',', ':'))
assert 15_000_000 < len(raw.encode()) < 16 * 1024 * 1024
sha = hashlib.sha256(raw.encode()).hexdigest()
id_ = '00000000-0000-0000-0000-000000000002'
detail = json.dumps({'delivery_id': id_, 'report': report, 'report_json': raw}, separators=(',', ':')).encode()
del report

class Mock(BaseHTTPRequestHandler):
    delay = 0
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['content-length'])))
        if self.path.endswith('/ingest_seosmith_audit'):
            assert data['p_report_json'] == raw and data['p_sha256'] == sha
            time.sleep(self.delay)
            payload = json.dumps({'delivery_id': id_, 'sha256': sha, 'accepted': True}).encode()
        else:
            payload = detail
        try:
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except BrokenPipeError:
            pass
    def log_message(self, *_args):
        pass

with tempfile.TemporaryDirectory(prefix='htp-large-profile-') as tmp:
    envelope = Path(tmp) / 'envelope.json'
    envelope.write_text(json.dumps({'delivery_id': id_, 'sha256': sha, 'report_json': raw}, separators=(',', ':')))
    server = HTTPServer(('127.0.0.1', 0), Mock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = os.environ.copy()
    env.update(HTP_PROFILE_UPSTREAM=f'http://127.0.0.1:{server.server_port}', HTP_PROFILE_ENVELOPE=str(envelope), HTP_PROFILE_SHA=sha)
    binary = str(Path(sys.argv[1]).resolve())
    def run(test):
        subprocess.run(['systemd-run', '--user', '--scope', '-p', 'MemoryMax=256M', '-p', 'CPUQuota=100%', '/usr/bin/time', '-v', binary, '--ignored', '--exact', f'seosmith::tests::{test}', '--nocapture'], env=env, check=True)
    run('profile_detail_http')
    run('profile_ingest_http')
    Mock.delay = 21
    env['HTP_PROFILE_EXPECT_TIMEOUT'] = '1'
    run('profile_ingest_http')
    server.shutdown()
