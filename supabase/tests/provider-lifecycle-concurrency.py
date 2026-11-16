# Run against an isolated PostgreSQL database with migrations applied:
# HTP_TEST_PG_CONTAINER=<container> HTP_TEST_PG_DATABASE=<database> python3 tests/provider-lifecycle-concurrency.py
import os, subprocess, time, uuid
base=['podman','exec','-i','-u','postgres',os.environ['HTP_TEST_PG_CONTAINER'],'psql','-X','-A','-t','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d',os.environ['HTP_TEST_PG_DATABASE']]
def call(sql):
    return subprocess.run(base,input=sql,text=True,capture_output=True,check=True).stdout.strip()
owner=str(uuid.uuid4())
site=str(uuid.uuid4())
call(f"insert into auth.users values('{owner}'); insert into public.websites(id,owner_id,fqdn,ga4_property_id) values('{site}','{owner}','example.com','123');")
prefix=f"set role authenticated; select set_config('request.jwt.claims', '{{\"sub\":\"{owner}\",\"is_anonymous\":false}}',false);"
def start(sql):
    p=subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    p.stdin.write(sql); p.stdin.close(); return p
def concurrent(key,other):
    first=start(prefix+f"begin; select public.register_provider_report_request('{site}','{key}','analytics','123','2025-01-01','2025-01-28'); select pg_sleep(2); commit;")
    for _ in range(100):
        if call("select count(*) from pg_stat_activity where wait_event='PgSleep'")=='1': break
        time.sleep(.05)
    else: raise AssertionError('first transaction did not reach sleep')
    result=call(prefix+other)
    first.wait(timeout=10)
    if first.returncode: raise RuntimeError(first.stderr.read())
    return result
r=concurrent('conflict',f"select public.register_provider_report_request('{site}','conflict','analytics','123','2025-01-01','2025-01-27');")
assert 'CONFLICT' in r,r
r=concurrent('withdraw',f"select public.cancel_provider_report_request('{site}','withdraw');")
assert 'withdrawn' in r,r
print('Postgres concurrent conflicting create and create/cancel: passed')

# A running claim holds the scheduler lock while cancellation waits; the
# committed withdrawal must leave the existing lease intact.
call(prefix+f"select public.register_provider_report_request('{site}','claim-race','analytics','123','2024-01-01','2024-01-28');")
call(f"insert into public.google_connections(owner_id,encrypted_grant,scopes,status) values('{owner}','',array['https://www.googleapis.com/auth/analytics.readonly'],'connected'); set role service_role; select public.claim_google_report();")
call(f"update public.google_report_jobs set lease=null,leased_until=null,next_run_at=now()+interval '1 day' where website_id='{site}'; update public.google_report_jobs set next_run_at=now()-interval '1 day' where website_id='{site}' and start_date='2024-01-01';")
claim=start("set role service_role; begin; select public.claim_google_report(); select pg_sleep(2); commit;")
for _ in range(100):
    if call("select count(*) from pg_stat_activity where wait_event='PgSleep'")=='1': break
    time.sleep(.05)
else: raise AssertionError('claim did not reach sleep')
withdrawn=call(prefix+f"select public.cancel_provider_report_request('{site}','claim-race');")
claim.wait(timeout=10)
if claim.returncode: raise RuntimeError(claim.stderr.read())
assert '2024-01-01' in claim.stdout.read()
assert 'withdrawn' in withdrawn
assert call(f"select (lease is not null)::int from public.google_report_jobs where website_id='{site}' and start_date='2024-01-01'")=='1'
# Reverse ordering: cancellation holds the lock and an overlapping claim cannot
# obtain it. After commit, a later claim cannot revive the withdrawn intent.
call(prefix+f"select public.register_provider_report_request('{site}','cancel-first','analytics','123','2023-01-01','2023-01-28');")
withdraw=start(prefix+f"begin; select public.cancel_provider_report_request('{site}','cancel-first'); select pg_sleep(2); commit;")
for _ in range(100):
    if call("select count(*) from pg_stat_activity where wait_event='PgSleep'")=='1': break
    time.sleep(.05)
else: raise AssertionError('cancel did not reach sleep')
assert call("set role service_role; select public.claim_google_report() is null")=='t'
withdraw.wait(timeout=10)
if withdraw.returncode: raise RuntimeError(withdraw.stderr.read())
call(f"update public.google_report_jobs set lease=null,leased_until=null,next_run_at=now()+interval '1 day' where website_id='{site}'; update public.google_report_jobs set next_run_at=now()-interval '1 day' where website_id='{site}' and start_date='2023-01-01';")
after=call("set role service_role; select public.claim_google_report();")
assert '2023-01-01' not in after
print('Postgres concurrent claim/cancel in both orders: passed')
# Scheduling a rolling job and registering the same natural key overlap.
# The scheduler commits first; withdrawing the keyed request cannot remove or
# shorten that shared scheduled job.
call(f"delete from public.google_report_jobs where website_id='{site}' and kind='analytics' and start_date=(now() at time zone 'UTC')::date-28 and end_date=(now() at time zone 'UTC')::date-1;")
scheduler=start("set role service_role; begin; select public.claim_google_report(); select pg_sleep(2); commit;")
for _ in range(100):
    if call("select count(*) from pg_stat_activity where wait_event='PgSleep'")=='1': break
    time.sleep(.05)
else: raise AssertionError('scheduler did not reach sleep')
shared=call(prefix+f"select public.register_provider_report_request('{site}','shared','analytics','123',(now() at time zone 'UTC')::date-28,(now() at time zone 'UTC')::date-1);")
scheduler.wait(timeout=10)
if scheduler.returncode: raise RuntimeError(scheduler.stderr.read())
assert 'accepted' in shared
assert 'withdrawn' in call(prefix+f"select public.cancel_provider_report_request('{site}','shared');")
assert call(f"select (collection_class='current' and refresh_until>now())::int from public.google_report_jobs where website_id='{site}' and kind='analytics' and start_date=(now() at time zone 'UTC')::date-28 and end_date=(now() at time zone 'UTC')::date-1")=='1'
print('Postgres concurrent scheduler/register with shared withdrawal: passed')
