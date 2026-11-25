"""Scoped claimant contract; synthetic rows, no provider, no hosted access.
Run: python3 supabase/tests/forms-delivery-scoped-claim-local.py
Requires a locally cached PG17 image (never pulls). Container uses no network,
ports, host mounts or persistent volumes; removed in finally, including failures.
The minimal schema models columns used by the exact source function definitions,
not the full production catalog or producer/owner mutation contract. Uses exact
legacy and successor definitions with separately versioned expectations.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'supabase/migrations/20261122000400_forms_notifications.sql'
IMAGE = 'public.ecr.aws/supabase/postgres:17.11.0.004'
# Pin the entire migration, not copied/reimplemented claimant logic.
SOURCE_SHA256 = '10cd5137acadf4940c55ff0a5a872170455cc035177696a1058861bbdd9fa51c'
NAME = 'forms-scoped-claim-fixture-' + uuid.uuid4().hex[:12]


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
        website_form_responses, website_forms, forms_pilot_approved_sites, websites,
        forms_notification_admissions, forms_notification_job_admissions;
        insert into websites values ('{uid(1)}','{uid(2)}');
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


def admit(active=True):
    sql(f"""insert into forms_notification_admissions(operation_id,website_id,owner_id,generation,active)
      values ('{uid(7)}','{uid(1)}','{uid(2)}','{uid(8)}',{str(active).lower()});""")


def label():
    # Explicit synthetic labeling only; migration never labels existing work.
    sql(f"insert into forms_notification_job_admissions values ('{uid(5)}','{uid(7)}','{uid(1)}','{uid(2)}','{uid(8)}');")


def setup():
    seed()
    admit()
    label()


class Session:
    def __init__(self, name):
        self.proc = subprocess.Popen(['docker','exec','-i',NAME,'psql','-X','-U','postgres',
            '-h','/tmp','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self.send(f"set application_name='{name}'; begin; set local statement_timeout='5s';")

    def send(self, text):
        self.proc.stdin.write(text + '\n')
        self.proc.stdin.flush()

    def line(self):
        import select
        assert select.select([self.proc.stdout], [], [], 8)[0], 'session output timeout'
        line = self.proc.stdout.readline().strip()
        if not line:
            details = self.proc.stderr.read() if self.proc.poll() is not None else 'empty SQL result'
            raise AssertionError('session failed: ' + details)
        return line

    def end(self):
        self.send('commit;')
        self.proc.stdin.close()
        self.proc.wait(timeout=8)
        assert self.proc.returncode == 0, self.proc.stderr.read()


def blocked(name):
    deadline = time.monotonic()+5
    while time.monotonic()<deadline:
        if sql(f"select exists(select 1 from pg_stat_activity where application_name='{name}' and wait_event_type='Lock');") == 't':
            return
        time.sleep(.02)
    raise AssertionError('expected lock wait: '+name)


def concurrency():
    close = """select 1 from forms_pilot_approved_sites order by website_id for share;
      select 1 from websites order by id for share;
      update forms_notification_admissions set active=false;"""
    setup()
    worker = Session('claim_first')
    worker.send("set local role service_role; select claim_form_delivery();")
    job = json.loads(worker.line())
    stopper = Session('close_second')
    stopper.send(close + "\nselect 'closed';")
    assert stopper.line() == '1'
    assert stopper.line() == '1'
    blocked('close_second')
    worker.end()
    assert stopper.line() == 'closed'
    stopper.end()
    assert claim() is None
    assert finish(job['lease']) == 't'
    print('PASS claim before close serializes; issued matching lease finishes after committed close', flush=True)
    setup()
    stopper = Session('close_first')
    stopper.send(close + "\nselect 'closed';")
    assert [stopper.line() for _ in range(3)] == ['1','1','closed']
    worker = Session('claim_second')
    worker.send("set local role service_role; select coalesce(claim_form_delivery(),'null'::jsonb);")
    blocked('claim_second')
    stopper.end()
    assert worker.line() == 'null'
    worker.end()
    assert sql('select state from website_form_delivery_jobs;') == 'pending'
    print('PASS close before claim blocks then refuses lease after commit', flush=True)
    setup()
    locker = Session('locked_job')
    locker.send(f"select id from website_form_delivery_jobs where id='{uid(5)}' for update;")
    assert locker.line() == uid(5)
    assert claim() is None
    locker.end()
    worker = Session('first_worker')
    worker.send('set local role service_role; select claim_form_delivery();')
    job = json.loads(worker.line())
    assert claim() is None
    worker.end()
    assert finish(job['lease']) == 't'
    print('PASS SKIP LOCKED and concurrent workers never issue duplicate lease', flush=True)


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
        create table websites(id uuid primary key,owner_id uuid);
        create table forms_pilot_approved_sites(website_id uuid primary key,owner_id uuid);
        create table website_forms(id uuid primary key,website_id uuid,name text,fields jsonb);
        create table website_form_responses(id uuid primary key,values jsonb,website_id uuid,form_id uuid);
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
        migration = ROOT / 'supabase/migrations/20261208000000_forms_notification_claim_fence.sql'
        migration_source = migration.read_text()
        print('fence_sha256=' + hashlib.sha256(migration_source.encode()).hexdigest(), flush=True)
        # Guard failures must roll back before installing the admission tables.
        for change, restore in [
            ("alter function claim_form_delivery() owner to service_role;",
             "alter function claim_form_delivery() owner to postgres; grant execute on function claim_form_delivery() to service_role;"),
            ("grant execute on function claim_form_delivery() to anon;",
             "revoke execute on function claim_form_delivery() from anon;"),
            ("alter function claim_form_delivery() set search_path=public;",
             "alter function claim_form_delivery() set search_path='';"),
            ("create role inherited_worker; grant execute on function claim_form_delivery() to inherited_worker; grant inherited_worker to authenticated;",
             "revoke inherited_worker from authenticated; drop owned by inherited_worker; drop role inherited_worker;"),
            ("create or replace function claim_form_delivery() returns jsonb language plpgsql security definer set search_path='' as $$ begin return null; end $$;",
             source[start:end].replace('create function public.', 'create or replace function public.')),
        ]:
            sql(change)
            try:
                sql(migration_source)
            except RuntimeError as error:
                assert 'notification_worker_' in str(error), str(error)
            else:
                raise AssertionError('migration accepted drift')
            assert sql("select to_regclass('forms_notification_admissions') is null;") == 't'
            sql(restore)
        print('PASS transactional owner/ACL/search-path/inherited/body drift guards', flush=True)
        # Lease issued by the exact legacy body before installation remains finishable.
        sql(f"""insert into website_forms values ('{uid(3)}','{uid(1)}','Synthetic','[]');
          insert into website_form_recipients values
            ('{uid(4)}','{uid(1)}','{uid(3)}','synthetic@example.invalid',true,null,now()+interval '1 day');
          insert into website_form_delivery_jobs(id,recipient_id,kind,secret_token)
            values ('{uid(5)}','{uid(4)}','verification','synthetic-token');""")
        legacy_lease = claim()['lease']
        sql(migration_source)
        assert sql("select count(*) from forms_notification_admissions;") == '0'
        assert finish(legacy_lease) == 't'
        print('PASS pre-migration legacy lease finishes after fence installation with no label or admission', flush=True)
        check('service-only claim and finish ACL', """has_function_privilege('service_role','claim_form_delivery()','execute')
          and has_function_privilege('service_role','finish_form_delivery(uuid,uuid,text)','execute')
          and not has_function_privilege('authenticated','claim_form_delivery()','execute')
          and not has_function_privilege('anon','finish_form_delivery(uuid,uuid,text)','execute')""")
        for table in ('forms_notification_admissions', 'forms_notification_job_admissions'):
            check('private RLS ' + table, f"relrowsecurity and relowner='postgres'::regrole from pg_class where oid='{table}'::regclass")
            for role in ('anon','authenticated','service_role'):
                assert sql(f"select has_table_privilege('{role}','{table}','select,insert,update,delete');") == 'f'
        seed()
        assert claim() is None
        admit(active=False)
        assert claim() is None
        sql('update forms_notification_admissions set active=true;')
        assert claim() is None  # legacy job remains unlabeled
        label()
        job = claim()
        assert job['id'] == uid(5) and job['generation'] == uid(8)
        sql('update forms_notification_admissions set active=false; delete from forms_pilot_approved_sites;')
        assert finish(uid(999)) == 'f'
        assert finish(job['lease']) == 't'
        assert finish(job['lease']) == 'f'
        print('PASS default closed / unlabeled legacy excluded / eligible lease / matching finish after close and approval removal', flush=True)
        for mutation in (
            'delete from forms_pilot_approved_sites;',
            f"update websites set owner_id='{uid(99)}';",
            f"update forms_notification_job_admissions set operation_id='{uid(99)}';",
            f"update forms_notification_job_admissions set website_id='{uid(99)}';",
            f"update forms_notification_job_admissions set owner_id='{uid(99)}';",
            f"update forms_notification_admissions set generation='{uid(99)}';",
            f"update website_forms set website_id='{uid(99)}';",
            'update website_form_recipients set enabled=false;',
            "update website_form_recipients set challenge_expires_at=now()-interval '1 second';",
        ):
            setup()
            sql(mutation)
            assert claim() is None, mutation
            assert sql('select state from website_form_delivery_jobs;') == 'pending'
        print('PASS approval/owner/operation/site/stale generation/form/recipient fail closed without mutation', flush=True)
        setup()
        sql(f"""insert into website_form_responses values ('{uid(6)}','{{}}','{uid(99)}','{uid(3)}');
          update website_form_recipients set verified_at=now();
          update website_form_delivery_jobs set kind='response',response_id='{uid(6)}',secret_token=null;""")
        assert claim() is None
        sql(f"update website_form_responses set website_id='{uid(1)}',form_id='{uid(99)}';")
        assert claim() is None
        sql(f"update website_form_responses set form_id='{uid(3)}';")
        assert claim()['id'] == uid(5)
        print('PASS response website and form consistency', flush=True)
        setup()
        job = claim()
        sql("update website_form_delivery_jobs set leased_until=now()-interval '1 second';")
        assert finish(job['lease']) == 'f'
        assert claim() is None
        assert sql('select state from website_form_delivery_jobs;') == 'sending'
        sql("update website_form_delivery_jobs set state='uncertain',lease=null,leased_until=null;")
        assert claim() is None
        print('PASS expired finish refused / no sweep / no uncertain resend', flush=True)
        setup()
        sql(f"""insert into website_form_recipients values
          ('{uid(14)}','{uid(11)}','{uid(13)}','other@example.invalid',false,null,now()-interval '1 day');
          insert into website_form_delivery_jobs(id,recipient_id,kind,state,lease,leased_until)
          values ('{uid(15)}','{uid(14)}','verification','sending','{uid(16)}',now()-interval '1 second');
          insert into website_form_delivery_jobs(id,recipient_id,kind,secret_token)
            values ('{uid(17)}','{uid(14)}','verification','synthetic-other');""")
        assert claim()['id'] == uid(5)
        assert claim() is None
        check('no global expiry sweep', f"state='sending' and lease='{uid(16)}' from website_form_delivery_jobs where id='{uid(15)}'")
        check('no global invalid-recipient cancellation', f"state='pending' and secret_token='synthetic-other' from website_form_delivery_jobs where id='{uid(17)}'")
        concurrency()
        print('RESULT: scoped worker fence cases passed; no provider invoked', flush=True)
    finally:
        run('docker', 'rm', '-f', '-v', NAME)
        remaining = run('docker', 'ps', '-a', '--filter', 'name=' + NAME, '--format', '{{.Names}}')
        assert not remaining, remaining
        print('CLEANUP: container removed; tmpfs data discarded; no volumes/mounts/ports', flush=True)


if __name__ == '__main__':
    main()
