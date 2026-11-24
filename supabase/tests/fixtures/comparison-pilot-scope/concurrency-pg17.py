#!/usr/bin/env python3
"""Synthetic PG17 lock-serialization and rollback fixture for the comparison pilot.

Disposable, loopback-free, one container, removed on exit. Never targets a hosted
service. Run from the repository root or any checkout of it.
"""
import subprocess, sys, time, uuid
from pathlib import Path

root = Path(__file__).resolve().parents[4]
image = 'public.ecr.aws/supabase/postgres:17.11.0.004'
name = 'comparison-pilot-' + uuid.uuid4().hex[:12]
pg = ['docker', 'exec', '-i', '-e', 'PGPASSWORD=fixture-only', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-h', '127.0.0.1', '-d', 'postgres']
owner, other, site, delivery = '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004'
site2 = '00000000-0000-0000-0000-000000000005'
source = "url,rule,state\nhttps://example.com/,missing_title,present"
claims = '{"sub":"%s","is_anonymous":false}' % owner


def sql(statement):
    p = subprocess.run(pg, input=statement, text=True, capture_output=True)
    if p.returncode:
        raise RuntimeError('disposable SQL failed: ' + p.stderr[-1200:])
    return p.stdout.strip()


def expect(actual, expected):
    assert actual == expected, (actual, expected)


def concurrent(statement, tag):
    proc = subprocess.Popen(pg, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    proc.stdin.write(f"SET application_name='{tag}'; BEGIN; {statement}; SELECT pg_sleep(8); COMMIT;\n")
    proc.stdin.close()
    for _ in range(150):
        if sql(f"select count(*) from pg_stat_activity where application_name='{tag}' and wait_event='PgSleep'") == '1':
            return proc
        if proc.poll() is not None:
            raise RuntimeError('concurrent transaction exited early: ' + proc.stderr.read()[-1000:])
        time.sleep(.1)
    proc.kill()
    raise RuntimeError('concurrent transaction never reached the barrier')


def blocked(statement, tag):
    proc = subprocess.Popen(pg, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    proc.stdin.write(f"SET application_name='{tag}'; {statement}\n")
    proc.stdin.close()
    for _ in range(100):
        if sql(f"select count(*) from pg_stat_activity where application_name='{tag}' and wait_event_type='Lock'") == '1':
            return proc
        if proc.poll() is not None:
            raise RuntimeError('statement did not block: ' + proc.stderr.read()[-1000:])
        time.sleep(.1)
    proc.kill()
    raise RuntimeError('statement never reached the lock wait')


def finish(proc, timeout=20):
    code = proc.wait(timeout=timeout)
    if code:
        raise RuntimeError('transaction failed: ' + proc.stderr.read()[-1200:])
    proc.stdout.close()
    proc.stdin.close()
    proc.stderr.close()


created = False
try:
    subprocess.run(['docker', 'run', '-d', '--rm', '--network=none', '--name', name, '--memory', '4g', '--shm-size', '512m', '--tmpfs', '/var/lib/postgresql/data:rw,size=3g', '-e', 'POSTGRES_PASSWORD=fixture-only', image], check=True, stdout=subprocess.DEVNULL)
    created = True
    for _ in range(120):
        try:
            if sql('select 1') == '1' and subprocess.run(['docker', 'logs', name], capture_output=True, text=True).stdout.find('PostgreSQL init process complete') >= 0:
                break
        except RuntimeError:
            pass
        time.sleep(1)
    else:
        raise RuntimeError('database not ready')
    sql("""create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
grant execute on function auth.jwt(), auth.uid() to public;""")
    for f in ['20261028142440_create_websites.sql', '20261031053344_seosmith_audits.sql', '20261124000000_independent_audit_comparisons.sql', '20261205000000_comparison_pilot_scope.sql']:
        sql((root / 'supabase/migrations' / f).read_text())
    sql(f"insert into auth.users(id) values ('{owner}'),('{other}'); insert into public.websites(id,owner_id,fqdn) values ('{site}','{owner}','example.com'),('{site2}','{owner}','other.example.com'); insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report) values ('{delivery}','{site}','example.com',1,repeat('a',64),'{{}}'); insert into public.comparison_pilot_approved_sites values ('{site}','{owner}');")
    for role in ['authenticated']:
        for signature in ['import_independent_audit(uuid,text,text,jsonb)', 'independent_audit_history(uuid,uuid,timestamptz,uuid)', 'save_independent_comparison(uuid,uuid,uuid,boolean)', 'independent_comparison_history(uuid,timestamptz,uuid)', 'independent_comparison_detail(uuid,uuid)', 'independent_evidence_fingerprint(uuid)', 'delete_independent_audit_evidence(uuid,text,text)', 'delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text)']:
            sql(f'grant execute on function public.{signature} to {role}')
    sql(f"select set_config('request.jwt.claims','{claims}',false); select public.import_independent_audit('{site}','controlled-csv-v1',E'{source}','{{}}');")

    # 1. Approval removal waits for an in-flight gated import and then invalidates
    #    the pair; the import that observed the approval commits unchanged.
    import_stmt = f"SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims','{claims}',true); SELECT public.import_independent_audit('{site}','controlled-csv-v1',E'{source}','{{}}')"
    proc = concurrent(import_stmt, 'cmp_gate_import')
    removal = blocked(f"DELETE FROM public.comparison_pilot_approved_sites WHERE website_id='{site}'", 'cmp_gate_removal')
    finish(proc)
    finish(removal)
    expect(sql(f"select count(*) from public.independent_audit_imports where website_id='{site}'"), '2')
    expect(sql(f"select count(*) from public.comparison_pilot_approved_sites where website_id='{site}'"), '0')
    denied = subprocess.run(pg, input=f"SET ROLE authenticated; select set_config('request.jwt.claims','{claims}',false); select public.independent_audit_history('{site}')", text=True, capture_output=True)
    assert denied.returncode != 0 and 'forbidden' in denied.stderr, (denied.returncode, denied.stderr[-400:])

    # 2. Scoped cleanup holds the website lock for its whole transaction; an
    #    ownership transfer waits and only sees the committed post-cleanup state.
    sql(f"insert into public.comparison_pilot_approved_sites values ('{site}','{owner}')")
    first_import = sql(f"select id from public.independent_audit_imports where website_id='{site}' order by created_at,id limit 1")
    sql(f"SET ROLE authenticated; select set_config('request.jwt.claims','{claims}',false); select public.save_independent_comparison('{site}','{first_import}','{delivery}',true)")
    ids = sql(f"select id from public.independent_audit_imports where website_id='{site}' order by id").split()
    cmp_ids = sql(f"select id from public.independent_audit_comparisons where website_id='{site}' order by id").split()
    fingerprint = sql(f"SET ROLE authenticated; select set_config('request.jwt.claims','{claims}',false); select public.independent_evidence_fingerprint('{site}')").splitlines()[-1]
    imports_sql = ','.join("'" + x + "'" for x in ids)
    comparisons_sql = ','.join("'" + x + "'" for x in cmp_ids)
    cleanup_stmt = f"SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims','{claims}',true); SELECT public.delete_comparison_pilot_evidence('{site}',ARRAY[{imports_sql}]::uuid[],ARRAY[{comparisons_sql}]::uuid[],'{fingerprint}')"
    proc = concurrent(cleanup_stmt, 'cmp_scoped_delete')
    transfer = blocked(f"UPDATE public.websites SET owner_id='{other}' WHERE id='{site}'", 'cmp_transfer')
    finish(proc)
    finish(transfer)
    expect(sql(f"select count(*) from public.independent_audit_imports where website_id='{site}'"), '0')
    expect(sql(f"select count(*) from public.independent_audit_comparisons where website_id='{site}'"), '0')
    expect(sql(f"select owner_id from public.websites where id='{site}'"), other)
    expect(sql(f"select count(*) from public.comparison_pilot_approved_sites where website_id='{site}'"), '1')

    # 3. Rollback: a mismatched scoped cleanup changes nothing, releases the lock,
    #    and a later approval removal is not blocked by it.
    sql(f"update public.websites set owner_id='{owner}' where id='{site}'; select set_config('request.jwt.claims','{claims}',false); select public.import_independent_audit('{site}','controlled-csv-v1',E'{source}','{{}}')")
    bad = subprocess.run(pg, input=f"SET ROLE authenticated; select set_config('request.jwt.claims','{claims}',false); select public.delete_comparison_pilot_evidence('{site}',ARRAY[{imports_sql}]::uuid[],ARRAY[]::uuid[],'wrong')", text=True, capture_output=True)
    assert bad.returncode != 0 and 'evidence_scope_mismatch' in bad.stderr, (bad.returncode, bad.stderr[-400:])
    expect(sql(f"select count(*) from public.independent_audit_imports where website_id='{site}'"), '1')
    sql(f"DELETE FROM public.comparison_pilot_approved_sites WHERE website_id='{site}'")
    expect(sql(f"select count(*) from public.comparison_pilot_approved_sites where website_id='{site}'"), '0')
    expect(sql(f"select count(*) from public.independent_audit_imports where website_id='{site}'"), '1')
    print('PASS: synthetic PG17 gate-removal and scoped-cleanup serialization, ownership transfer, and rollback preservation')
finally:
    if created:
        subprocess.run(['docker', 'rm', '-f', name], check=True, stdout=subprocess.DEVNULL)
        print('PASS: disposable container removed')
