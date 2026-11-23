#!/usr/bin/env python3
"""Private restored PG17 rehearsal; never targets a network database."""
import os, subprocess, time, uuid
from pathlib import Path

root = Path(__file__).resolve().parents[4]
base = Path('/mnt/storage/projects/integration/private-rollout/w1-recovery-20261122')
name = 'receipt-fixture-' + uuid.uuid4().hex[:12]
pg = ['podman', 'exec', '-i', '-e', 'PGPASSWORD=synthetic-restore', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-h', '127.0.0.1', '-d', 'postgres']
def sql(s):
    p = subprocess.run(pg, input=s, text=True, capture_output=True)
    if p.returncode: raise RuntimeError('disposable SQL failed: ' + p.stderr[-1200:])
    return p.stdout.strip()
def ident(n): return f'00000000-0000-0000-0000-{n:012d}'
site, owner, other, form, sub = map(ident, [3, 1, 2, 5, 7])
query = (root/'supabase/operations/forms-pilot-receipt.sql').read_text()
def receipt(submission=sub, who=owner, site_id=site, form_id=form):
    args = ','.join("'%s'" % x for x in [site_id, who, form_id, submission])
    out = sql('BEGIN READ ONLY; PREPARE receipt(uuid,uuid,uuid,uuid) AS\n'+query+'\nEXECUTE receipt('+args+'); COMMIT;')
    assert out in {'scope_unavailable','active_receipt','deleted_receipt','ambiguous','no_receipt_observed'}, out
    return out
def check(actual, expected):
    assert actual == expected, (actual, expected)

def concurrent(statement):
    proc = subprocess.Popen(pg, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    proc.stdin.write("SET application_name='receipt_synthetic_inflight'; BEGIN; " + statement + "; SELECT pg_sleep(8); COMMIT;\n")
    proc.stdin.close()
    for _ in range(150):
        if sql("select count(*) from pg_stat_activity where application_name='receipt_synthetic_inflight' and wait_event='PgSleep'") == '1': return proc
        if proc.poll() is not None: raise RuntimeError('concurrent fixture exited early: '+proc.stderr.read()[-1000:])
        time.sleep(.1)
    proc.kill(); raise RuntimeError('concurrent fixture did not reach barrier')
def finish(proc):
    code=proc.wait(timeout=15)
    if code: raise RuntimeError('concurrent transaction failed: '+proc.stderr.read()[-1000:])
    proc.stdout.close(); proc.stderr.close()

created=False
try:
    subprocess.run(['podman','run','-d','--rm','--network=none','--name',name,'--memory','4g','--shm-size','512m','--tmpfs','/var/lib/postgresql/data:rw,size=3g','-e','POSTGRES_PASSWORD=synthetic-restore','public.ecr.aws/supabase/postgres:17.11.0.003'],check=True,stdout=subprocess.DEVNULL)
    created=True
    for _ in range(90):
        try:
            if sql('select 1') == '1': break
        except RuntimeError: time.sleep(1)
    else: raise RuntimeError('database not ready')
    decrypt=subprocess.Popen(['/tmp/w1-age','-d','-i',str(Path.home()/'.config/sops/age/keys.txt'),str(base/'database.dump.age')],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    restore=subprocess.run(['podman','exec','-i','-e','PGPASSWORD=synthetic-restore',name,'pg_restore','--clean','--if-exists','--no-owner','--no-acl','--exit-on-error','-U','supabase_admin','-h','127.0.0.1','-d','postgres'],stdin=decrypt.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    decrypt.stdout.close(); decerr=decrypt.stderr.read(); rc=decrypt.wait()
    if restore.returncode or rc: raise RuntimeError('restore failed')
    check(sql('select count(*) from supabase_migrations.schema_migrations'), '29')
    files = sorted((root/'supabase/migrations').glob('2026112200*.sql')) + [root/'supabase/migrations/20261128000000_forms_host_challenge_quota.sql']
    for f in files: sql(f.read_text())
    sql("""create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;""")
    sql("select set_config('forms.pilot_fixture','disposable',false);\n"+(root/'supabase/migrations/20261201000000_forms_pilot_scope.sql').read_text())
    sql("select set_config('forms.pilot_fixture','disposable',false);\n"+(root/'supabase/tests/fixtures/forms-pilot-scope/seed.sql').read_text())
    check(receipt(), 'no_receipt_observed')
    check(sql('BEGIN READ ONLY; PREPARE receipt(uuid,uuid,uuid,uuid) AS\n'+query+f"\nEXECUTE receipt('{site}','{owner}','{form}',NULL); COMMIT;"), 'scope_unavailable')
    check(receipt(who=other), 'scope_unavailable')
    check(receipt(form_id=ident(11)), 'scope_unavailable')
    accept = f"select public.accept_website_form('{form}','{sub}','example.com','{{}}')"
    proc=concurrent(accept)
    check(receipt(), 'no_receipt_observed')
    finish(proc); check(receipt(), 'active_receipt')
    sql(f"delete from public.forms_pilot_approved_sites where website_id='{site}'")
    check(receipt(), 'active_receipt')
    check(sql(accept), '{"error": "form_unavailable"}')
    sql(f"insert into public.forms_pilot_approved_sites values ('{site}','{owner}')")
    deletion=f"select public.delete_website_form_response('{site}','{form}',(select id from public.website_form_responses where form_id='{form}' and submission_id='{sub}'))"
    claims='{"sub":"'+owner+'","is_anonymous":false}'
    proc=concurrent("select set_config('request.jwt.claims','"+claims+"',true); "+deletion)
    check(receipt(), 'active_receipt')
    finish(proc); check(receipt(), 'deleted_receipt')
    sql(f"insert into public.website_form_responses(website_id,form_id,submission_id,values) values('{site}','{form}','{sub}','{{}}')")
    check(receipt(), 'ambiguous')
    sql(f"update public.websites set owner_id='{other}' where id='{site}'")
    check(receipt(), 'scope_unavailable')
    print('PASS: restored PG17 receipt scope, gate removal, actual accept/delete and in-flight snapshots, ambiguous and ownership transfer')
finally:
    if created:
        subprocess.run(['podman','rm','-f',name],check=True,stdout=subprocess.DEVNULL)
        print('PASS: disposable container removed')
