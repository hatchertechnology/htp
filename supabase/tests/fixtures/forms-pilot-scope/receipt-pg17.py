#!/usr/bin/env python3
"""Synthetic PG17 regression; never targets a network database."""
import subprocess, time, uuid
from pathlib import Path

root = Path(__file__).resolve().parents[4]
name = 'receipt-fixture-' + uuid.uuid4().hex[:12]
pg = ['docker', 'exec', '-i', '-e', 'PGPASSWORD=fixture-only', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-h', '127.0.0.1', '-d', 'postgres']
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
    assert out in {'scope_unavailable','active_receipt','deleted_receipt','ambiguous','no_receipt_observed','visibility_unavailable'}, out
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
    subprocess.run(['docker','run','-d','--rm','--network=none','--name',name,'--memory','4g','--shm-size','512m','--tmpfs','/var/lib/postgresql/data:rw,size=3g','-e','POSTGRES_PASSWORD=fixture-only','public.ecr.aws/supabase/postgres@sha256:e85bc10ac5b141223b289e1e8dc8d448cf3df92501917149db0366b9c5aaf053'],check=True,stdout=subprocess.DEVNULL)
    created=True
    for _ in range(90):
        try:
            if sql('select 1') == '1': break
        except RuntimeError: time.sleep(1)
    else: raise RuntimeError('database not ready')
    sql("""create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
grant execute on function auth.jwt(), auth.uid() to public;""")
    files = [root/'supabase/migrations/20261028142440_create_websites.sql'] + sorted((root/'supabase/migrations').glob('2026112200*.sql')) + [root/'supabase/migrations/20261128000000_forms_host_challenge_quota.sql']
    for f in files: sql(f.read_text())
    sql("select set_config('forms.pilot_fixture','disposable',false);\n"+(root/'supabase/migrations/20261201000000_forms_pilot_scope.sql').read_text())
    sql("select set_config('forms.pilot_fixture','disposable',false);\n"+(root/'supabase/tests/fixtures/forms-pilot-scope/seed.sql').read_text())
    check(receipt(), 'no_receipt_observed')
    for index in range(4):
        args = [f"'{x}'" for x in (site, owner, form, sub)]
        args[index] = 'NULL'
        check(sql('BEGIN READ ONLY; PREPARE receipt(uuid,uuid,uuid,uuid) AS\n'+query+'\nEXECUTE receipt('+','.join(args)+'); COMMIT;'), 'scope_unavailable')
    check(receipt(site_id=ident(4)), 'scope_unavailable')
    check(receipt(who=other), 'scope_unavailable')
    check(receipt(form_id=ident(11)), 'scope_unavailable')
    accept = f"select public.accept_website_form('{form}','{sub}','example.com','{{}}')"
    proc=concurrent(accept)
    check(receipt(), 'no_receipt_observed')
    finish(proc); check(receipt(), 'active_receipt')
    sibling=ident(12)
    sql(f"insert into public.website_forms(id,website_id,form_key,name,fields,active) select '{sibling}',website_id,'sibling','Sibling',fields,active from public.website_forms where id='{form}'; insert into public.website_form_submission_tombstones(form_id,submission_id,value_hash) values('{sibling}','{sub}','synthetic')")
    check(receipt(), 'active_receipt')
    check(receipt(form_id=sibling), 'deleted_receipt')
    sql(f"delete from public.forms_pilot_approved_sites where website_id='{site}'")
    check(receipt(), 'active_receipt')
    check(sql(accept), '{"error": "form_unavailable"}')
    sql(f"insert into public.forms_pilot_approved_sites values ('{site}','{owner}')")
    deletion=f"select public.delete_website_form_response('{site}','{form}',(select id from public.website_form_responses where form_id='{form}' and submission_id='{sub}'))"
    claims='{"sub":"'+owner+'","is_anonymous":false}'
    proc=concurrent("select set_config('request.jwt.claims','"+claims+"',true); "+deletion)
    check(receipt(), 'active_receipt')
    finish(proc); check(receipt(), 'deleted_receipt')
    # Synthetic role sees the scope and active table but its SELECT on tombstones
    # is filtered by RLS. The prior query silently reported no receipt here.
    sql("""create role receipt_filtered nologin;
      grant usage on schema public to receipt_filtered;
      grant select on public.websites, public.website_forms, public.website_form_responses,
        public.website_form_submission_tombstones to receipt_filtered;
      create policy receipt_fixture_site on public.websites for select to receipt_filtered using (true);
      create policy receipt_fixture_form on public.website_forms for select to receipt_filtered using (true);
      create policy receipt_fixture_response on public.website_form_responses for select to receipt_filtered using (true);""")
    check(sql(f"set role receipt_filtered; select count(*) from public.websites w join public.website_forms f on f.website_id=w.id where w.id='{site}' and f.id='{form}'"), '1')
    check(sql(f"set role receipt_filtered; select count(*) from public.website_form_submission_tombstones where form_id='{form}' and submission_id='{sub}'"), '0')
    args=','.join("'%s'" % x for x in [site, owner, form, sub])
    check(sql('BEGIN READ ONLY; SET LOCAL ROLE receipt_filtered; PREPARE receipt(uuid,uuid,uuid,uuid) AS\n'+query+'\nEXECUTE receipt('+args+'); COMMIT;'), 'visibility_unavailable')
    check(receipt(), 'deleted_receipt')  # fully visible administrator still sees evidence
    sql(f"insert into public.website_form_responses(website_id,form_id,submission_id,values) values('{site}','{form}','{sub}','{{}}')")
    check(receipt(), 'ambiguous')
    sql(f"update public.websites set owner_id='{other}' where id='{site}'")
    check(receipt(), 'scope_unavailable')
    print('PASS: synthetic PG17 receipt scope, gate removal, actual accept/delete and in-flight snapshots, ambiguous, filtered RLS, full visibility and ownership transfer')
finally:
    if created:
        subprocess.run(['docker','rm','-f',name],check=True,stdout=subprocess.DEVNULL)
        print('PASS: disposable container removed')
