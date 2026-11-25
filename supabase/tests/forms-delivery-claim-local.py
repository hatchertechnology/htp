"""Legacy claimant contract; synthetic rows, no provider, no hosted access.
Run: python3 supabase/tests/forms-delivery-claim-local.py
Requires a locally cached PG17 image (never pulls). Container uses no network,
ports, host mounts or persistent volumes; removed in finally, including failures.
The minimal schema models columns used by the exact source function definitions,
not the full production catalog/ACL/producer/locking contract. A successor can
reuse seed(), sql() and check(), with separately versioned expected behavior.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'supabase/migrations/20261122000400_forms_notifications.sql'
IMAGE = os.environ.get('FORMS_TEST_POSTGRES_IMAGE', 'public.ecr.aws/supabase/postgres:17.11.0.004')
# Pin the entire migration, not copied/reimplemented claimant logic.
SOURCE_SHA256 = '10cd5137acadf4940c55ff0a5a872170455cc035177696a1058861bbdd9fa51c'
NAME = 'forms-claim-fixture-' + uuid.uuid4().hex[:12]


def run(*args, source=None):
    result = subprocess.run(args, input=source, text=True, capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError(f'{args[0:2]} failed: {result.stderr}')
    return result.stdout.strip()


def sql(source):
    return run('docker', 'exec', '-i', NAME, 'psql', '-X', '-U', 'postgres',
               '-h', '/tmp', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1', source=source)


def uid(n):
    return f'00000000-0000-0000-0000-{n:012d}'


def seed():
    sql(f"""truncate website_form_delivery_jobs, website_form_recipients,
        website_form_responses, website_forms, forms_pilot_approved_sites;
        insert into forms_pilot_approved_sites values ('{uid(1)}','{uid(2)}');
        insert into website_forms values ('{uid(3)}','{uid(1)}','Synthetic','[]');
        insert into website_form_recipients values
          ('{uid(4)}','{uid(1)}','{uid(3)}','synthetic@example.invalid',true,null,now()+interval '1 day');
        insert into website_form_delivery_jobs(id,recipient_id,kind,secret_token)
          values ('{uid(5)}','{uid(4)}','verification','synthetic-token');""")


def claim():
    return json.loads(sql("set role service_role; select coalesce(claim_form_delivery(),'null'::jsonb);"))


def check(label, predicate):
    if sql(f'select coalesce((select {predicate}),false);') != 't':
        raise AssertionError(label)
    print('PASS ' + label, flush=True)


def finish(lease, state='sent'):
    return sql(f"set role service_role; select finish_form_delivery('{uid(5)}','{lease}','{state}');")


def main():
    source = SOURCE.read_text()
    if hashlib.sha256(source.encode()).hexdigest() != SOURCE_SHA256:
        raise AssertionError('legacy source drift: review and version expectations before repinning')
    # Use immutable locally resolved image ID, no pull or registry access.
    image_id = run('docker', 'image', 'inspect', IMAGE, '--format', '{{.Id}}')
    print('source_sha256=' + SOURCE_SHA256, flush=True)
    print('image_id=' + image_id, flush=True)
    try:
        run('docker', 'run', '-d', '--pull=never', '--name', NAME, '--network=none',
            '--tmpfs', '/var/lib/postgresql/data:rw,mode=1777',
            '--user', 'postgres', '--entrypoint', 'sh', image_id, '-c',
            'initdb -D /var/lib/postgresql/data/fixture -A trust >/tmp/init.log && '
            'exec postgres -D /var/lib/postgresql/data/fixture -k /tmp -c listen_addresses=')
        config = json.loads(run('docker', 'inspect', NAME))[0]
        assert config['HostConfig']['NetworkMode'] == 'none'
        assert not config['HostConfig'].get('PortBindings')
        assert not config['HostConfig'].get('Binds')
        assert not any(m['Type'] in ('bind', 'volume') for m in config.get('Mounts', []))
        for _ in range(100):
            ready = subprocess.run(['docker', 'exec', NAME, 'pg_isready', '-h', '/tmp', '-U', 'postgres'],
                                   capture_output=True, timeout=5)
            if ready.returncode == 0:
                break
            time.sleep(.1)
        else:
            raise RuntimeError('PG readiness timeout')
        version = sql('show server_version_num;')
        assert 170000 <= int(version) < 180000, version
        print('server_version_num=' + version, flush=True)
        sql("""create role anon; create role authenticated; create role service_role;
        create table forms_pilot_approved_sites(website_id uuid primary key,owner_id uuid);
        create table website_forms(id uuid primary key,website_id uuid,name text,fields jsonb);
        create table website_form_responses(id uuid primary key,values jsonb);
        create table website_form_recipients(id uuid primary key,website_id uuid,form_id uuid,
          email text,enabled boolean,verified_at timestamptz,challenge_expires_at timestamptz);
        create table website_form_delivery_jobs(id uuid primary key default gen_random_uuid(),
          recipient_id uuid,response_id uuid,kind text,secret_token text,state text default 'pending',
          lease uuid,leased_until timestamptz,attempts integer default 0,
          created_at timestamptz default now(),updated_at timestamptz default now());""")
        # Include exact definitions plus their original revoke/grant statements.
        start = source.index('create function public.claim_form_delivery()')
        end = source.index('create function public.retry_form_delivery(', start)
        sql(source[start:end])
        check('service-only claim and finish ACL', """has_function_privilege('service_role','claim_form_delivery()','execute')
          and has_function_privilege('service_role','finish_form_delivery(uuid,uuid,text)','execute')
          and not has_function_privilege('authenticated','claim_form_delivery()','execute')
          and not has_function_privilege('anon','finish_form_delivery(uuid,uuid,text)','execute')""")
        seed()
        # Each sql()/claim()/finish() is a separate committed connection: worker
        # pauses here after lease return, closure commits, then worker finishes.
        job = claim()
        assert job['id'] == uid(5) and job['token'] == 'synthetic-token'
        check('claim issues two-minute sending lease', f"state='sending' and attempts=1 and lease='{job['lease']}' and leased_until>now() and leased_until<=now()+interval '2 minutes' from website_form_delivery_jobs where id='{uid(5)}'")
        sql('delete from forms_pilot_approved_sites;')
        assert finish(job['lease']) == 't'
        check('matching in-flight finish survives committed approval removal', "state='sent' and lease is null and leased_until is null and secret_token is null from website_form_delivery_jobs")
        assert finish(job['lease']) == 'f'
        print('PASS completed lease cannot finish twice', flush=True)
        seed()
        sql('delete from forms_pilot_approved_sites;')
        job = claim()
        assert job['id'] == uid(5)
        print('PASS legacy claim still issues lease after approval removal (hazard)', flush=True)
        assert finish(uid(999)) == 'f'
        check('stale lease leaves active attempt intact', f"state='sending' and lease='{job['lease']}' and attempts=1 from website_form_delivery_jobs")
        sql("update website_form_delivery_jobs set leased_until=now()-interval '1 second';")
        assert finish(job['lease']) == 'f'
        print('PASS expired lease refuses finish', flush=True)
        # Second site has no approval and is unrelated to the original target.
        sql(f"""insert into website_form_recipients values
          ('{uid(14)}','{uid(11)}','{uid(13)}','other@example.invalid',false,null,now()+interval '1 day');
          insert into website_form_delivery_jobs(id,recipient_id,kind,secret_token)
          values ('{uid(15)}','{uid(14)}','verification','synthetic-other');""")
        assert claim() is None
        check('global expiry sweep clears expired lease and secret', f"state='uncertain' and lease is null and leased_until is null and secret_token is null and attempts=1 from website_form_delivery_jobs where id='{uid(5)}'")
        check('global invalid-recipient sweep touches unrelated unapproved site', f"state='cancelled' and secret_token is null and attempts=0 from website_form_delivery_jobs where id='{uid(15)}'")
        assert claim() is None
        check('uncertain delivery is never automatically requeued', f"state='uncertain' and attempts=1 from website_form_delivery_jobs where id='{uid(5)}'")
        print('RESULT: 10 legacy contract cases passed; no provider invoked', flush=True)
    finally:
        run('docker', 'rm', '-f', '-v', NAME)
        remaining = run('docker', 'ps', '-a', '--filter', 'name=' + NAME, '--format', '{{.Names}}')
        assert not remaining, remaining
        print('CLEANUP: container removed; tmpfs data discarded; no volumes/mounts/ports', flush=True)


if __name__ == '__main__':
    main()
