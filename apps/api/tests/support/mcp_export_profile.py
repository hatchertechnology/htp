#!/usr/bin/env python3
"""Synthetic local MCP profile; upstream mock runs outside measured API scope."""
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Mock(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers['content-length']))
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        if self.path.endswith('/seosmith_audit_export_access'):
            self.wfile.write(b'true')
            return
        assert self.path.endswith('/seosmith_audit_detail')
        if '--inline' in sys.argv:
            self.wfile.write(b'{"report":[' + b'0,' * 130000 + b'0]}')
            return
        self.wfile.write(b'{"delivery_id":"00000000-0000-0000-0000-000000000002","report":{"schema_version":2,"padding":[')
        if '--token-heavy' in sys.argv:
            block = b'0,' * 7590
            for _ in range(999): self.wfile.write(block)
            self.wfile.write(block[:-1]); self.wfile.write(b']},"report_json":"{\\"schema_version\\":2,\\"padding\\":[')
            for _ in range(999): self.wfile.write(block)
            self.wfile.write(block[:-1]); self.wfile.write(b']}"}')
        else:
            block = (b'1' + b'0' * 100 + b',') * 1000
            for _ in range(999): self.wfile.write(block)
            self.wfile.write(block[:-1]); self.wfile.write(b']},"report_json":"{\\"schema_version\\":2,\\"padding\\":[')
            block = b'1e100,' * 1000
            for _ in range(999): self.wfile.write(block)
            self.wfile.write(block[:-1]); self.wfile.write(b']}"}')
    def log_message(self, *_): pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = os.environ.copy()
env['HTP_MCP_PROFILE_UPSTREAM'] = f'http://127.0.0.1:{server.server_port}'
if '--token-heavy' in sys.argv: env['HTP_MCP_PROFILE_MIN'] = '30000000'
try:
    subprocess.run(['systemd-run','--user','--scope','-p','MemoryMax=256M','-p','CPUQuota=100%','sh','-c', '"$@"; status=$?; printf "CGROUP_MEMORY_PEAK "; cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.peak"; exit "$status"','profile','/usr/bin/time','-v',sys.argv[1], '--ignored','--exact',('profile_concurrent_inline_mcp' if '--inline' in sys.argv else 'profile_large_audit_export_mcp'),'--nocapture'],env=env,check=True)
finally: server.shutdown()
