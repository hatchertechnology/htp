"""Source-only regression in a disposable local PostgreSQL container.
Usage: python supabase/tests/forms-confirmation-guards.py CONTAINER
No network endpoint or hosted credentials are used. Creates/drops isolated test databases.
"""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
CONTAINER = sys.argv[1]
SIGNATURE = 'public.confirm_form_recipient(uuid,text)'
FORWARD = (ROOT / 'supabase/migrations/20261207000000_forms_confirmation_pilot_fence.sql').read_text()
ROLLBACK = (ROOT / 'supabase/rollbacks/20261207000000_forms_confirmation_pilot_fence.sql').read_text()
SEED = (ROOT / 'supabase/tests/forms-confirmation-local.sql').read_text().split('\\i /tmp/confirm-migration.sql')[0]
SEED = '\n'.join(line for line in SEED.splitlines() if not line.startswith('create role '))


def sql(database, source, success=True):
    result = subprocess.run(
        ['docker', 'exec', '-i', CONTAINER, 'psql', '-X', '-U', 'postgres', '-d', database,
         '-v', 'ON_ERROR_STOP=1', '-Atq'], input=source, text=True, capture_output=True, timeout=20,
    )
    if success:
        assert result.returncode == 0, result.stderr
    else:
        assert result.returncode != 0, 'drift was accepted'
        assert 'forms_confirmation_' in result.stderr and '_drift' in result.stderr, result.stderr
    return result.stdout.strip()


def snapshot(database):
    return json.loads(sql(database, f"""select json_build_object(
        'oid',oid, 'owner',proowner, 'body',prosrc, 'acl',proacl,
        'config',proconfig, 'definer',prosecdef)
        from pg_proc where oid='{SIGNATURE}'::regprocedure;"""))


# Roles are cluster-wide; all databases below are created solely by this test.
sql('postgres', """do $$ begin
    if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
    if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if;
    if not exists(select from pg_roles where rolname='confirm_drift') then create role confirm_drift; end if;
end $$;""")

CASES = {
    'body': f"""do $test$ begin execute replace(pg_get_functiondef('{SIGNATURE}'::regprocedure),
        'begin', E'begin\\n-- unreviewed change'); end $test$;""",
    'owner': f'alter function {SIGNATURE} owner to confirm_drift;',
    'search_path': f'alter function {SIGNATURE} set search_path=public;',
    'extra_config': f"alter function {SIGNATURE} set statement_timeout='1s';",
    'definer': f'alter function {SIGNATURE} security invoker;',
    'acl_public': f'grant execute on function {SIGNATURE} to public;',
    'acl_authenticated': f'grant execute on function {SIGNATURE} to authenticated;',
    'acl_extra': f'grant execute on function {SIGNATURE} to confirm_drift;',
    'acl_missing_service': f'revoke execute on function {SIGNATURE} from service_role;',
    'acl_missing_owner': f'revoke execute on function {SIGNATURE} from postgres;',
    'acl_grant_option': f'grant execute on function {SIGNATURE} to service_role with grant option;',
}

count = 0
for direction, migration in [('forward', FORWARD), ('rollback', ROLLBACK)]:
    for case, drift in [('identity', None), *CASES.items()]:
        database = f'confirm_guard_{direction}_{case}'
        sql('postgres', f'create database {database};')
        try:
            sql(database, SEED)
            legacy = snapshot(database)
            if direction == 'rollback':
                sql(database, FORWARD)
            if drift:
                sql(database, drift)
                before = snapshot(database)
                sql(database, migration, success=False)
                assert snapshot(database) == before, f'{direction}/{case}: refused migration changed function'
            else:
                before = snapshot(database)
                sql(database, migration)
                after = snapshot(database)
                assert before['oid'] == after['oid'] == legacy['oid'], 'function identity changed'
                assert after['acl'] == legacy['acl'], 'ACL changed'
                assert after['owner'] == legacy['owner'] and after['config'] == legacy['config']
                if direction == 'rollback':
                    assert after == legacy, 'rollback did not restore exact legacy function'
                    sql(database, FORWARD)
                    assert snapshot(database)['oid'] == legacy['oid'], 'reapply changed OID'
            count += 1
            print(f'PASS {direction}/{case}')
        finally:
            sql('postgres', f'drop database {database};')
print(f'{count} guard/identity cases passed')
