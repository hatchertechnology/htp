import base64, hashlib, hmac, json, os, subprocess, threading, time, uuid
import requests

root, pg, port = os.environ['ROOT'], os.environ['PG'], os.environ['RESTPORT']
def sql(q):
    return subprocess.check_output(['podman','exec','-e','PGPASSWORD=dryrun',pg,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','supabase_admin','-h','127.0.0.1','-d','postgres','-c',q], text=True).strip()
def enc(x): return base64.urlsafe_b64encode(json.dumps(x,separators=(',',':')).encode()).rstrip(b'=').decode()
t=enc({'alg':'HS256','typ':'JWT'})+'.'+enc({'role':'authenticated','sub':'00000000-0000-4000-8000-0000000000aa','is_anonymous':False,'exp':int(time.time())+3600})
token=t+'.'+base64.urlsafe_b64encode(hmac.new(b'local-test-secret-at-least-32-bytes-long',t.encode(),hashlib.sha256).digest()).rstrip(b'=').decode()
url=f'http://127.0.0.1:{port}/rpc/import_seosmith_audit'
for _ in range(60):
    try: requests.get(f'http://127.0.0.1:{port}/',timeout=1); break
    except requests.RequestException: time.sleep(.2)
else: raise RuntimeError('PostgREST not ready')
fixture=json.load(open(root+'/supabase/tests/fixtures/contracts/v2-complete.json'))
fixture['request']['website_id']='00000000-0000-4000-8000-000000000002'
fixture['request']['url']='https://example.com/'
fixture['private_probe_sentinel']='synthetic-secret-body-must-not-appear'
def call(trace, rid, invalid=False, header=None):
    x=json.loads(json.dumps(fixture)); x['request']['request_id']=rid
    if invalid: x['request']['url']='https://wrong.example/'
    return requests.post(url,headers={'Authorization':'Bearer '+token,'traceparent':header if header is not None else f'00-{trace}-1111111111111111-01'},json={'p_website_id':'00000000-0000-4000-8000-000000000002','p_report_json':json.dumps(x,separators=(',',':'))},timeout=12)
traces=['1'*32,'2'*32,'3'*32]
r=call(traces[0],str(uuid.uuid4())); assert r.status_code==200, (r.status_code,r.text)
r=call(traces[1],str(uuid.uuid4()),True); assert r.status_code==400, (r.status_code,r.text)
sql("alter function public.import_seosmith_audit(uuid,text) set statement_timeout='3s'")
rid=str(uuid.uuid4()); lock=subprocess.Popen(['podman','exec','-e','PGPASSWORD=dryrun',pg,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','supabase_admin','-h','127.0.0.1','-d','postgres','-c',f"select pg_advisory_lock(hashtextextended('{rid}',0)); select pg_sleep(8)"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
    for _ in range(40):
        if sql("select count(*) from pg_locks where locktype='advisory' and granted")=='1': break
        time.sleep(.1)
    else: raise AssertionError('lock not acquired')
    result={}
    def run(): result['r']=call(traces[2],rid)
    thread=threading.Thread(target=run); thread.start(); observed=False
    for _ in range(25):
        count=sql("select count(*) from pg_stat_activity where application_name='htp-import:"+traces[2]+"' and state='active' and wait_event_type='Lock'")
        if count=='1': observed=True; break
        time.sleep(.1)
    assert observed, 'no correlated lock wait seen'
    queued_trace='4'*32; queued={}
    queued_thread=threading.Thread(target=lambda: queued.update(r=call(queued_trace,str(uuid.uuid4())))); queued_thread.start()
    time.sleep(.5)
    current_logs=subprocess.check_output(['podman','logs',pg],stderr=subprocess.STDOUT,text=True)
    assert f'htp_import trace={queued_trace} phase=entry' not in current_logs, 'queued request unexpectedly entered SQL'
    thread.join(10); queued_thread.join(10); assert not thread.is_alive() and not queued_thread.is_alive()
    assert queued['r'].status_code==200, queued['r'].status_code
    assert result['r'].status_code==500, result['r'].status_code
    assert sql("select count(*) from public.seosmith_audits where delivery_id='"+rid+"'")=='0'
finally:
    lock.terminate(); lock.wait(timeout=5)
bad='private-untrusted-sentinel'
r=call('5'*32,str(uuid.uuid4()),header=bad); assert r.status_code==200
logs=subprocess.check_output(['podman','logs',pg],stderr=subprocess.STDOUT,text=True)
assert bad not in logs
assert 'synthetic-secret-body-must-not-appear' not in logs
assert 'htp_import trace='+'4'*32+' phase=entry' in logs
assert 'htp_import trace='+'5'*32 not in logs
for trace, phases in zip(traces,[['entry','complete'],['entry','error'],['entry','canceled']]):
    for phase in phases: assert f'htp_import trace={trace} phase={phase}' in logs, (trace,phase)
assert sql("select count(*) from pg_stat_activity where application_name like 'htp-import:%'")=='0'
print('success, error, cancellation markers observed; timed-out row absent; active lock wait correlated; queued request invisible until SQL entry; malformed header ignored; application_name reset')
