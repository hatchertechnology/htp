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
