#!/usr/bin/env python3
"""Fail closed unless the running, local service chain uses the test stack."""
import re
import subprocess
import sys
from pathlib import Path
from local_url import check


def listener(url, name):
    u = check(url)
    result = subprocess.check_output(['ss', '-H', '-ltnp', f'sport = :{u.port}'], text=True)
    lines = [line for line in result.splitlines() if re.search(rf'users:\(\("{name}",pid=\d+', line)]
    if len(lines) != 1 or len(result.splitlines()) != 1:
        raise SystemExit(f'expected one {name} listener on port {u.port}')
    line = lines[0]
    address = line.split()[3]
    if not (address.startswith('127.0.0.1:') or address.startswith('[::1]:')):
        raise SystemExit('listener must bind only loopback')
    pid = int(re.search(r'pid=(\d+)', line).group(1))
    env = dict(item.split('=', 1) for item in Path(f'/proc/{pid}/environ').read_bytes().decode().split('\0') if '=' in item)
    for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        if env.get(key):
            raise SystemExit(f'{name} has an active proxy setting')
    return env


def api(endpoint):
    u = check(endpoint)
    if u.port not in (3967, 3969) or u.path != '/integrations/seosmith/policy-audits':
        raise SystemExit('HTP endpoint must be the dedicated local test API')
    env = listener(endpoint, 'htp-api')
    db = check(env.get('SUPABASE_URL', ''))
    if db.port != 56321 or db.path not in ('', '/'):
        raise SystemExit('HTP must use the dedicated local Supabase API')
    running = subprocess.check_output(['podman', '--remote=false', 'inspect', '--format', '{{.State.Running}}', 'supabase_db_w1c8e'], text=True).strip()
    kong = subprocess.check_output(['podman', '--remote=false', 'inspect', '--format', '{{.State.Running}}', 'supabase_kong_w1c8e'], text=True).strip()
    if kong != 'true':
        raise SystemExit('dedicated local Supabase API is not running')
    ports = subprocess.check_output(['podman', '--remote=false', 'port', 'supabase_kong_w1c8e', '8000/tcp'], text=True).splitlines()
    if not any(p.rsplit(':', 1)[-1] == '56321' for p in ports):
        raise SystemExit('dedicated local Supabase API is not published on port 56321')
    if running != 'true':
        raise SystemExit('dedicated local database is not running')

if __name__ == '__main__':
    if sys.argv[1] == 'crawl':
        env = listener(sys.argv[2], 'seosmith')
        if len(sys.argv) > 3 and sys.argv[3] == 'https://fixture.example/' and not env.get('SEOSMITH_LOCAL_FIXTURES'):
            raise SystemExit('fixture crawl requires network-free FixtureTransport')
        api(env.get('HTP_INGEST_URL', ''))
    elif sys.argv[1] == 'probe':
        api(sys.argv[2])
    else:
        raise SystemExit('unknown preflight mode')
