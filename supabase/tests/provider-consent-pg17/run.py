#!/usr/bin/env python3
"""Network-disabled synthetic ledger45 PG17 rehearsal; no hosted access or secrets."""
import json
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = '20261206000000_provider_consent_fence.sql'
NAME = 'consent-fence-' + uuid.uuid4().hex[:12]
IMAGE = 'public.ecr.aws/supabase/postgres:17.11.0.004'
PG = ['podman', 'exec', '-i', NAME, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres']
OWNER = str(uuid.UUID(int=1))
OTHER = str(uuid.UUID(int=2))
SERVICE = 'set role service_role; '


def run(statement, ok=True):
    p = subprocess.run(PG, input=statement, text=True, capture_output=True)
    if ok:
        assert p.returncode == 0, p.stderr[-2000:]
        return p.stdout.strip()
    assert p.returncode != 0, 'expected rejection'
    return p.stderr


def begin(owner, provider):
    return json.loads(run(SERVICE + f"select public.begin_provider_consent('{owner}','{provider}')"))


def disconnect(owner, provider):
    return f"select public.disconnect_provider_consent('{owner}','{provider}')"


def complete(owner, provider, fence, grant='synthetic'):
    generation = "null" if fence['generation'] is None else "'%s'" % fence['generation']
    return f"select public.complete_provider_consent('{owner}','{provider}','{fence['epoch']}',{generation},'{grant}',array['synthetic.scope'])"


def row(owner, provider):
    return run(f"select row_to_json(c) from public.{provider}_connections c where owner_id='{owner}'")


def spawn(statement, tag):
    p = subprocess.Popen(PG, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    p.stdin.write(f"set application_name='{tag}'; " + statement + '\n')
    p.stdin.close()
    return p


def wait_for(tag, event):
    for _ in range(100):
        if run(f"select count(*) from pg_stat_activity where application_name='{tag}' and {event}") == '1':
            return
        time.sleep(.03)
    raise AssertionError('barrier not reached: ' + tag)


def finish(p):
    assert p.wait(timeout=15) == 0, p.stderr.read()
    return p.stdout.read().strip()


def race(first, second, expected):
    tag = 'consent_' + uuid.uuid4().hex[:8]
    a = spawn('begin; ' + SERVICE + first + '; select pg_sleep(3); commit;', tag)
    wait_for(tag, "wait_event='PgSleep'")
    b = spawn(SERVICE + second + ';', tag + '_wait')
    wait_for(tag + '_wait', "wait_event_type='Lock'")
    finish(a)
    assert finish(b) == expected


created = False
try:
    subprocess.run(['podman', 'run', '-d', '--rm', '--network=none', '--name', NAME,
                    '--tmpfs', '/var/lib/postgresql/data:rw,size=2g', '-e', 'POSTGRES_PASSWORD=fixture-only', IMAGE],
                   check=True, stdout=subprocess.DEVNULL)
    created = True
    for _ in range(90):
        p = subprocess.run(PG, input='select 1', text=True, capture_output=True)
        logs = subprocess.run(['podman', 'logs', NAME], text=True, capture_output=True)
        if p.returncode == 0 and 'PostgreSQL init process complete' in logs.stdout + logs.stderr:
            break
        time.sleep(.5)
    else:
        raise AssertionError('PG17 not ready')
    assert run('select version()').startswith('PostgreSQL 17.')
    run("""create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
create schema fixture;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations(version text primary key, name text, statements text[]);
""")
    # Reconstruct only the 45 source migrations through the recorded pilot baseline.
    # No encrypted restore, actual user data, credentials or unrelated pending SQL.
    baseline = sorted(p for p in (ROOT / 'supabase/migrations').glob('*.sql') if p.name <= '20261201000000_forms_pilot_scope.sql')
    assert len(baseline) == 45, len(baseline)
    for p in baseline:
        run(p.read_text())
        run(f"insert into supabase_migrations.schema_migrations (version) values('{p.name.split('_')[0]}')")
    prior_ledger = "select md5(string_agg(version,',' order by version)) from supabase_migrations.schema_migrations where version <> '20261206000000'"
    before = run(prior_ledger)
    run(f"insert into auth.users(id) values('{OWNER}'),('{OTHER}')")
    run(f"insert into public.google_connections(owner_id,encrypted_grant,scopes) values('{OTHER}','existing-wire-grant',array['old.scope'])")
    preserved = row(OTHER, 'google')
    migration = (ROOT / 'supabase/migrations' / MIGRATION).read_text()
    candidate = subprocess.run(['python3', str(ROOT / 'supabase/deploy/provider-consent-fence-ledger45.py')], check=True, text=True, capture_output=True).stdout
    run(candidate.removesuffix('commit;\n') + 'rollback;\n')
    assert run("select to_regclass('public.provider_consent_fences') is null") == 't'
    assert row(OTHER, 'google') == preserved
    run(candidate)
    assert 'consent_ledger45_version_drift' in run(candidate, False)
    assert run("select statements[1] like '%create table public.provider_consent_fences%' from supabase_migrations.schema_migrations where version='20261206000000'") == 't'
    assert run("select count(*) from supabase_migrations.schema_migrations") == '46'
    assert run(prior_ledger) == before
    assert row(OTHER, 'google') == preserved
    assert run("select to_regclass('public.seosmith_remediation') is null") == 't'
    print('PG17 synthetic ledger45 + isolated migration preview/commit: passed', flush=True)

    signatures = ['begin_provider_consent(uuid,text)', 'disconnect_provider_consent(uuid,text)', 'complete_provider_consent(uuid,text,uuid,uuid,text,text[])']
    for role in ['anon', 'authenticated']:
        for signature in signatures:
            assert run(f"select has_function_privilege('{role}','public.{signature}','execute')") == 'f'
        assert 'permission denied' in run(f'set role {role}; select * from public.provider_consent_fences', False)
        assert 'permission denied' in run(f'set role {role}; ' + disconnect(OWNER, 'google'), False)
    assert run("select bool_and(not prosecdef and proconfig=array['search_path=\"\"']) from pg_proc where proname in ('begin_provider_consent','disconnect_provider_consent','complete_provider_consent')") == 't'
    assert 'permission denied' in run(SERVICE + 'delete from public.provider_consent_fences', False)
    assert 'invalid provider' in run(SERVICE + f"select public.begin_provider_consent('{OWNER}','invalid')", False)
    assert 'invalid provider' in run(SERVICE + f"select public.begin_provider_consent('{OWNER}',null)", False)
    assert run('select count(*) from public.provider_consent_fences') == '0'
    print('Invoker/service-only function and table ACLs, invalid provider: passed', flush=True)

    for provider in ['google', 'bing']:
        # Snapshot of absence never creates or changes connection data.
        f = begin(OWNER, provider)
        assert f['generation'] is None
        assert row(OWNER, provider) == ''
        assert begin(OWNER, provider) == f
        # Disconnect first: callback waits, then cannot resurrect its absent generation.
        race(disconnect(OWNER, provider), complete(OWNER, provider, f), 'f')
        tombstone = json.loads(row(OWNER, provider))
        assert tombstone['status'] == 'disconnected' and tombstone['encrypted_grant'] == ''
        if provider == 'google':
            assert tombstone['scopes'] == []
        # Callback first: disconnect waits, then clears the successfully committed grant.
        f = begin(OWNER, provider)
        race(complete(OWNER, provider, f), disconnect(OWNER, provider), 't')
        assert json.loads(row(OWNER, provider))['status'] == 'disconnected'
        # Two callbacks with the same snapshot: exactly one wins; later consent reconnects.
        f = begin(OWNER, provider)
        race(complete(OWNER, provider, f, 'winner'), complete(OWNER, provider, f, 'loser'), 'f')
        assert json.loads(row(OWNER, provider))['encrypted_grant'] == 'winner'
        fresh = begin(OWNER, provider)
        assert run(SERVICE + complete(OWNER, provider, fresh, 'reconnected')) == 't'
        assert run(SERVICE + complete(OWNER, provider, f, 'stale')) == 'f'
        # Existing writer changes generation without changing fence: generation CAS still fails.
        fresh = begin(OWNER, provider)
        race(f"update public.{provider}_connections set generation=gen_random_uuid(),encrypted_grant='external' where owner_id='{OWNER}'", complete(OWNER, provider, fresh), 'f')
        # Other owner and provider stay independent; captured epoch cannot cross owners.
        other = begin(OTHER, provider)
        assert run(SERVICE + complete(OTHER, provider, fresh)) == 'f'
        assert begin(OTHER, provider) == other
        assert run(SERVICE + complete(OTHER, provider, other)) == 't'
        # Missing fence never authorizes a callback; no implicit creation by callback.
        third = str(uuid.uuid4())
        run(f"insert into auth.users(id) values('{third}')")
        assert run(SERVICE + complete(third, provider, fresh)) == 'f'
        missing = begin(third, provider)
        # Concurrent existing writer inserts an absent row: callback cannot upsert over it.
        scopes = ",scopes" if provider == 'google' else ''
        values = ",array[]::text[]" if provider == 'google' else ''
        race(f"insert into public.{provider}_connections(owner_id,encrypted_grant{scopes}) values('{third}','external'{values})", complete(third, provider, missing), 'f')
        # Atomic failure after fence update: a rejecting connection trigger rolls epoch back.
        fresh = begin(OWNER, provider)
        saved = row(OWNER, provider)
        run(f"""create function fixture.reject_write() returns trigger language plpgsql as $$begin raise exception 'synthetic failure'; end$$;
create trigger reject_write before insert or update on public.{provider}_connections for each row execute function fixture.reject_write();""")
        assert 'synthetic failure' in run(SERVICE + disconnect(OWNER, provider), False)
        assert begin(OWNER, provider) == fresh and row(OWNER, provider) == saved
        assert 'synthetic failure' in run(SERVICE + complete(OWNER, provider, fresh), False)
        assert begin(OWNER, provider) == fresh and row(OWNER, provider) == saved
        run(f'drop trigger reject_write on public.{provider}_connections; drop function fixture.reject_write()')
        assert 'division by zero' in run('begin; ' + SERVICE + disconnect(OWNER, provider) + '; select 1/0; commit;', False)
        assert begin(OWNER, provider) == fresh and row(OWNER, provider) == saved
    print('Both providers: absent/existing races, reconnect, owner isolation, failures: passed', flush=True)

    # The fence row itself is absent: concurrent disconnects serialize while
    # materializing it; neither can fail open through a missing-row SELECT lock.
    absent_owner = str(uuid.uuid4())
    run(f"insert into auth.users(id) values('{absent_owner}')")
    race(disconnect(absent_owner, 'google'), disconnect(absent_owner, 'google'), 't')
    assert json.loads(row(absent_owner, 'google'))['status'] == 'disconnected'
    # Two concurrent absent-row callbacks also serialize on the fence row.
    new_owner = str(uuid.uuid4())
    run(f"insert into auth.users(id) values('{new_owner}')")
    f = begin(new_owner, 'google')
    race(complete(new_owner, 'google', f), complete(new_owner, 'google', f), 'f')
    # A new explicit reconnect completes while the stale callback is in flight.
    stale = begin(OWNER, 'google')
    run(SERVICE + disconnect(OWNER, 'google'))
    reconnect = begin(OWNER, 'google')
    race(complete(OWNER, 'google', reconnect, 'new-consent'), complete(OWNER, 'google', stale), 'f')
    assert json.loads(row(OWNER, 'google'))['encrypted_grant'] == 'new-consent'
    # Holding one owner's fence does not serialize a different owner or provider.
    other_fence = begin(OTHER, 'google')
    bing_fence = begin(OWNER, 'bing')
    holder = spawn('begin; ' + SERVICE + disconnect(OWNER, 'google') + '; select pg_sleep(5); commit;', 'owner_isolation')
    wait_for('owner_isolation', "wait_event='PgSleep'")
    assert run(SERVICE + complete(OTHER, 'google', other_fence)) == 't'
    assert run(SERVICE + complete(OWNER, 'bing', bing_fence)) == 't'
    assert holder.poll() is None, 'independent owner/provider unexpectedly waited for holder'
    finish(holder)
    # An error-free snapshot on Bing is unaffected by Google disconnect.
    f = begin(OWNER, 'bing')
    run(SERVICE + disconnect(OWNER, 'google'))
    assert begin(OWNER, 'bing') == f
    assert run(SERVICE + complete(OWNER, 'bing', f)) == 't'
    # Losing a response is ambiguous, but repeating a callback cannot rewrite data.
    f = begin(OWNER, 'google')
    run(SERVICE + complete(OWNER, 'google', f))  # discard acknowledgment
    saved = row(OWNER, 'google')
    assert run(SERVICE + complete(OWNER, 'google', f)) == 'f'
    assert row(OWNER, 'google') == saved
    saved_google, saved_bing = row(OWNER, 'google'), row(OWNER, 'bing')
    rollback = subprocess.run(['python3', str(ROOT / 'supabase/deploy/provider-consent-fence-ledger45.py'), '--rollback'], check=True, text=True, capture_output=True).stdout
    run(rollback)
    assert run("select count(*) from supabase_migrations.schema_migrations") == '45'
    assert row(OWNER, 'google') == saved_google and row(OWNER, 'bing') == saved_bing
    assert run("select to_regclass('public.provider_consent_fences') is null") == 't'
    assert run(prior_ledger) == before
    run(candidate)
    print('Absent callback race, provider isolation, discarded acknowledgment, rollback/reapply: passed', flush=True)
finally:
    if created:
        subprocess.run(['podman', 'rm', '-f', NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
