"""Real Forms migration schema, synthetic parent/auth only; network-none PG17.
No hosted access/provider. Applies Forms migrations in ledger order, including
20261208 claim and 20261209 producer. Run with python3; cached image only.
"""
import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('harness',Path(__file__).with_name('forms-delivery-scoped-claim-local.py'))
h=importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
h.NAME='forms-producer-fixture-'+uuid.uuid4().hex[:12]
sql=h.sql; run=h.run; uid=h.uid; blocked=h.blocked

class Session(h.Session):
    def line(self):
        import select
        if not select.select([self.proc.stdout], [], [], 8)[0]:
            raise AssertionError("session output timeout")
        line=self.proc.stdout.readline().strip()
        if not line:
            raise AssertionError("empty session output; use a non-NULL single-row marker")
        return line
MIG=ROOT/'supabase/migrations/20261209000000_forms_notification_producer_fence.sql'
AUTH=f"set request.jwt.claim.sub='{uid(2)}'; set request.jwt.claims='{{\"is_anonymous\":false}}';"

def owner(query): return sql(AUTH+query)
def refused(query, fragment=None):
    try: sql(query)
    except RuntimeError as e:
        if fragment: assert fragment in str(e),str(e)
    else: raise AssertionError('expected refusal')
def request(): return owner(f"select request_form_recipient('{uid(1)}','{uid(3)}','synthetic@example.invalid');")
def confirm(): return sql(f"select confirm_form_recipient('{recipient()}',(select secret_token from website_form_delivery_jobs where kind='verification' order by created_at desc limit 1));")
def recipient(): return sql(f"select id from website_form_recipients where website_id='{uid(1)}' order by created_at desc limit 1;")
def job(): return sql("select id from website_form_delivery_jobs where kind='verification' order by created_at desc limit 1;")
def accept(n=6): return f"select accept_website_form('{uid(3)}','{uid(n)}','example.invalid','{{\"message\":\"Synthetic\"}}');"
def disable(): return f"select disable_form_recipient('{uid(1)}','{uid(3)}','{recipient()}');"
def retry(j=None): return f"select retry_form_delivery('{uid(1)}','{uid(3)}','{j or job()}');"
def close(): return f"""do $$ begin
 perform 1 from forms_pilot_approved_sites where website_id='{uid(1)}' for share;
 perform 1 from websites where id='{uid(1)}' for share;
 update forms_notification_admissions set active=false where website_id='{uid(1)}'; end $$;"""
def seed(active=True):
    sql(f"""truncate websites,auth.users,forms_pilot_approved_sites,forms_notification_admissions,
    forms_notification_job_admissions,website_forms,website_form_hosts,website_form_origins,
    website_form_responses,website_form_recipients,website_form_delivery_jobs,
    website_form_ingress_windows,website_form_rate_windows,website_form_submission_tombstones,website_form_host_challenge_windows;
    insert into auth.users values('{uid(2)}');
    insert into websites values('{uid(1)}','{uid(2)}','example.invalid');
    insert into forms_pilot_approved_sites values('{uid(1)}','{uid(2)}');
    insert into forms_notification_admissions values('{uid(7)}','{uid(1)}','{uid(2)}','{uid(8)}',{str(active).lower()});
    insert into website_forms(id,website_id,form_key,name,fields,active) values
    ('{uid(3)}','{uid(1)}','contact','Synthetic','[{{"key":"message","label":"Message","kind":"text","required":true,"max_length":100}}]',true);
    insert into website_form_hosts(id,website_id,hostname,challenge_hash,verified_at) values('{uid(4)}','{uid(1)}','example.invalid','synthetic',now());
    insert into website_form_origins values('{uid(1)}','{uid(3)}','{uid(4)}');""")

def acl():
    return sql("""select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,p.proowner,p.proacl,p.prosecdef,p.proconfig) order by p.oid)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';""")

def concurrency():
    # Every producer holds scope until commit; close serializes in both orders.
    for name in ('request','disable','confirmation','retry','accept'):
        for first in ('producer','close'):
            seed(); request(); r=recipient(); j=job()
            query={'request':f"select request_form_recipient('{uid(1)}','{uid(3)}','fresh@example.invalid');",
                   'disable':disable(),'confirmation':f"select confirm_form_recipient('{r}',(select secret_token from website_form_delivery_jobs where id='{j}'));",
                   'retry':retry(),'accept':accept()}[name]
            if name=='retry': sql("update website_form_delivery_jobs set state='failed';")
            a=Session('producer_'+name); b=Session('close_'+name)
            if first=='producer':
                a.send(AUTH+query); a.line()
                b.send(close()+"select 'closed';"); blocked('close_'+name)
                a.end(); assert b.line()=='closed'; b.end()
            else:
                b.send(close()+"select 'closed';"); assert b.line()=='closed'
                a.send(AUTH+query); blocked('producer_'+name); b.end()
                if name in ('request','disable','retry'):
                    a.proc.stdin.close(); a.proc.wait(timeout=8)
                    assert a.proc.returncode!=0
                    assert 'not found' in a.proc.stderr.read().lower()
                else:
                    result=a.line(); a.end()
                    assert result=='f' if name=='confirmation' else json.loads(result)['ok']
            assert sql('select active from forms_notification_admissions;')=='f'
        print('PASS '+name+' vs close both orderings with observed Lock barriers',flush=True)
    # Claim/producer content lock order: deletion waits on label before form.
    seed(); request(); assert confirm()=='t'; owner(accept())
    response=sql('select id from website_form_responses;')
    sql("update website_form_delivery_jobs set state='sent',secret_token=null;")
    worker=Session('claim_delete'); worker.send("select coalesce(claim_form_delivery(),'null'::jsonb);"); assert worker.line()=='null'
    # Explicit claimant-order locks, even completed candidate is no longer eligible.
    worker.send('with locked as materialized (select job_id from forms_notification_job_admissions order by job_id for share) select count(*) from locked;')
    assert worker.line()=='2'
    deleter=Session('delete_wait'); deleter.send(AUTH+f"select delete_website_form_response('{uid(1)}','{uid(3)}','{response}');")
    blocked('delete_wait'); worker.end(); assert deleter.line()=='t'; deleter.end()
    print('PASS response deletion waits on labels before form; completed labels/jobs cleaned atomically',flush=True)
    for mutation in (f"update websites set owner_id='{uid(99)}';",'delete from forms_pilot_approved_sites;',f"update forms_notification_admissions set generation='{uid(99)}';"):
        seed(); request()
        p=Session('producer_holds'); p.send(AUTH+disable()); assert p.line()=='t'
        changer=Session('changer_wait'); changer.send(mutation+"select 'changed';"); blocked('changer_wait');p.end();assert changer.line()=='changed';changer.end()
    print('PASS producer serializes ownership, approval deletion and generation changes',flush=True)
    for mutation in (f"update websites set owner_id='{uid(99)}';",'delete from forms_pilot_approved_sites;', 'update forms_notification_admissions set active=false;'):
        seed(); request(); query=disable()
        changer=Session('change_first');changer.send(mutation+"select 'changed';");assert changer.line()=='changed'
        p=Session('producer_after_change');p.send(AUTH+query);blocked('producer_after_change');changer.end()
        p.proc.stdin.close();p.proc.wait(timeout=8);assert p.proc.returncode!=0 and 'not found' in p.proc.stderr.read().lower()
    print('PASS committed owner/approval/admission changes block then refuse producer',flush=True)
    for first in ('claim','close'):
        seed();request();w=Session('worker_scope');c=Session('close_scope')
        if first=='claim':
            w.send('select claim_form_delivery();');lease=json.loads(w.line());c.send(close()+"select 'closed';");blocked('close_scope');w.end();assert c.line()=='closed';c.end()
            assert sql(f"select finish_form_delivery('{lease['id']}','{lease['lease']}','sent');")=='t'
        else:
            c.send(close()+"select 'closed';");assert c.line()=='closed';w.send("select coalesce(claim_form_delivery(),'null'::jsonb);");blocked('worker_scope');c.end();assert w.line()=='null';w.end()
    print('PASS full Forms schema claim/close both orderings and postclose finish',flush=True)
    # Inject a label after deletion's first discovery while it waits for form.
    seed();request();owner(accept());response=sql('select id from website_form_responses;')
    holder=Session('form_held');holder.send(f"select 1 from website_forms where id='{uid(3)}' for update;");assert holder.line()=='1'
    d=Session('new_label_delete');d.send(AUTH+f"select delete_website_form_response('{uid(1)}','{uid(3)}','{response}');");blocked('new_label_delete')
    sql(f"""insert into website_form_delivery_jobs(id,recipient_id,response_id,kind,state) values('{uid(77)}','{recipient()}','{response}','response','sent');
      insert into forms_notification_job_admissions values('{uid(77)}','{uid(7)}','{uid(1)}','{uid(2)}','{uid(8)}');""")
    labels=Session('late_label');labels.send(f"select 1 from forms_notification_job_admissions where job_id='{uid(77)}' for share;");assert labels.line()=='1'
    holder.end();d.proc.stdin.close();d.proc.wait(timeout=8);assert d.proc.returncode!=0 and 'could not obtain lock' in d.proc.stderr.read();labels.end()
    assert sql('select count(*) from website_form_responses;')=='1'
    print('PASS late label race refuses atomically without reverse lock wait',flush=True)
    # Website DELETE cannot wait backwards for an approval held by a claimant.
    seed(False)
    approval=Session('approval_held');approval.send('select 1 from forms_pilot_approved_sites for share;');assert approval.line()=='1'
    refused(f"delete from websites where id='{uid(1)}';",'could not obtain lock');approval.end()
    assert sql('select count(*) from websites;')=='1'
    print('PASS website reverse approval contention NOWAIT rolls back without data loss',flush=True)



def cases():
    seed(False)
    refused(AUTH+f"select request_form_recipient('{uid(1)}','{uid(3)}','synthetic@example.invalid');",'Form not found')
    assert json.loads(owner(accept()))['ok']; assert sql('select count(*) from website_form_delivery_jobs;')=='0'
    seed(); r=request(); assert confirm()=='t'; assert json.loads(owner(accept()))['ok']
    assert sql('select count(*) from forms_notification_job_admissions;')=='2'
    assert sql('select count(*) from website_form_delivery_jobs j left join forms_notification_job_admissions l on l.job_id=j.id where l.job_id is null;')=='0'
    print('PASS request/confirmation/response enqueue labels atomically under active scope',flush=True)
    sql(close()); refused(AUTH+disable(),'not found'); refused(AUTH+retry(),'not found'); assert confirm()=='f'
    assert json.loads(owner(accept(16)))['ok']; assert sql('select count(*) from website_form_delivery_jobs;')=='2'
    print('PASS closed producers refuse; normal contact submission continues without enqueue',flush=True)
    seed(); request(); sql("update website_form_recipients set created_at=now()-interval '1 hour';")
    lease=json.loads(sql('select claim_form_delivery();')); before=sql('select row_to_json(j) from website_form_delivery_jobs j;')
    refused(AUTH+f"select request_form_recipient('{uid(1)}','{uid(3)}','synthetic@example.invalid');",'unresolved')
    assert before==sql('select row_to_json(j) from website_form_delivery_jobs j;')
    assert owner(disable())=='t'; assert before==sql('select row_to_json(j) from website_form_delivery_jobs j;')
    sql(close()); assert sql(f"select finish_form_delivery('{lease['id']}','{lease['lease']}','sent');")=='t'
    print('PASS request refuses sending replacement; disable preserves sending lease; finish survives close',flush=True)
    seed(); request(); j=job(); sql("update website_form_delivery_jobs set state='failed';"); assert owner(retry())=='t'
    sql("update website_form_delivery_jobs set state='uncertain';"); assert owner(retry())=='f'
    sql(f"update forms_notification_admissions set generation='{uid(9)}'; update website_form_delivery_jobs set state='failed';")
    assert owner(retry())=='f'; assert confirm()=='f'; assert sql('select claim_form_delivery() is null;')=='t'
    sql("update website_form_recipients set created_at=now()-interval '1 hour';"); request()
    assert sql(f"select generation='{uid(9)}' from forms_notification_job_admissions where job_id='{job()}';")=='t'
    print('PASS failed same-generation retry only; uncertain/stale excluded; fresh invitation labels new generation',flush=True)
    for mutation in ('delete from forms_pilot_approved_sites;',f"update websites set owner_id='{uid(99)}';",f"update forms_notification_admissions set owner_id='{uid(99)}';"):
        seed(); request(); sql(mutation); assert confirm()=='f'; refused(AUTH+disable(),'not found')
    seed(); request()
    refused(f"set request.jwt.claim.sub='{uid(99)}'; set request.jwt.claims='{{\"is_anonymous\":false}}';"+disable(),'not found')
    refused(AUTH+"set request.jwt.claims='{\"is_anonymous\":true}';"+disable(),'not found')
    refused(AUTH+f"select disable_form_recipient('{uid(1)}','{uid(99)}','{recipient()}');",'not found')
    assert sql('select enabled from website_form_recipients;')=='t'
    print('PASS approval/ownership/cross-owner/cross-form/anonymous refusals',flush=True)
    # Real FK and trigger deletion behavior, retaining tombstone idempotency.
    seed(); request(); confirm(); owner(accept()); resp=sql('select id from website_form_responses;')
    sql("update website_form_delivery_jobs set state='sending',lease=gen_random_uuid(),leased_until=now()+interval '2 minutes' where kind='response';")
    delete=AUTH+f"select delete_website_form_response('{uid(1)}','{uid(3)}','{resp}');"
    refused(delete,'currently sending'); assert sql('select count(*) from forms_notification_job_admissions;')=='2'
    sql("update website_form_delivery_jobs set state='sent',lease=null,leased_until=null;")
    assert sql(delete)=='t'; assert sql('select count(*) from forms_notification_job_admissions;')=='1'
    assert json.loads(owner(accept()))['duplicate']
    refused(f"delete from websites where id='{uid(1)}';",'Close notification')
    sql(close()); sql(f"delete from websites where id='{uid(1)}';")
    assert sql('select count(*) from forms_notification_job_admissions;')=='0'
    assert sql('select count(*) from forms_notification_admissions;')=='0'
    print('PASS real FK response deletion after completed jobs; tombstone preserved; closed website cleanup supported',flush=True)
    seed(); request(); sql("update website_form_delivery_jobs set state='failed'; delete from forms_notification_job_admissions;")
    assert owner(retry())=='f'; assert confirm()=='f'
    assert sql('select count(*) from forms_notification_job_admissions;')=='0'
    print('PASS no implicit labeling/adoption of legacy failed work',flush=True)
    seed(); request()
    sql(f"""insert into websites values('{uid(11)}','{uid(12)}','other.invalid');
    insert into forms_pilot_approved_sites values('{uid(11)}','{uid(12)}');
    insert into forms_notification_admissions values('{uid(17)}','{uid(11)}','{uid(12)}','{uid(18)}',true);
    insert into website_forms(id,website_id,form_key,name,fields) values('{uid(13)}','{uid(11)}','other','Other','[]');
    insert into website_form_recipients(id,website_id,form_id,email,challenge_hash,challenge_expires_at)
      values('{uid(14)}','{uid(11)}','{uid(13)}','other@example.invalid','synthetic',now()+interval '1 day');
    insert into website_form_delivery_jobs(id,recipient_id,kind,state) values('{uid(15)}','{uid(14)}','verification','uncertain');
    insert into forms_notification_job_admissions values('{uid(15)}','{uid(17)}','{uid(11)}','{uid(12)}','{uid(18)}');""")
    unrelated=sql(f"select row_to_json(j) from website_form_delivery_jobs j where id='{uid(15)}';")
    refused(AUTH+f"select disable_form_recipient('{uid(1)}','{uid(3)}','{uid(14)}');",'not found')
    assert owner(retry(uid(15)))=='f'
    assert owner(disable())=='t'
    assert unrelated==sql(f"select row_to_json(j) from website_form_delivery_jobs j where id='{uid(15)}';")
    print('PASS cross-site recipient/job refusal and unrelated uncertainty preserved',flush=True)
    concurrency()


def main():
    prior=[p for p in sorted((ROOT/'supabase/migrations').glob('*forms*.sql')) if p.name<MIG.name]
    roster=hashlib.sha256(''.join(p.name+':'+hashlib.sha256(p.read_bytes()).hexdigest()+'\n' for p in prior).encode()).hexdigest()
    assert roster=='43405698ad7815634f0cdf83ee104c7a2eae7cedf50db1e4eae967c40a76952d', 'baseline Forms source drift'
    print('baseline_roster_sha256='+roster,flush=True)
    image=run('docker','image','inspect',h.IMAGE,'--format','{{.Id}}'); print('image_id='+image,flush=True)
    try:
        run('docker','run','-d','--pull=never','--name',h.NAME,'--network=none','--tmpfs','/var/lib/postgresql/data:rw,mode=1777','--user','postgres','--entrypoint','sh',image,'-c','initdb -D /var/lib/postgresql/data/fixture -A trust >/tmp/init.log && exec postgres -D /var/lib/postgresql/data/fixture -k /tmp -c listen_addresses=')
        config=json.loads(run('docker','inspect',h.NAME))[0]
        assert config['HostConfig']['NetworkMode']=='none' and not config['HostConfig'].get('PortBindings') and not config['HostConfig'].get('Binds')
        assert not any(m['Type'] in ('bind','volume') for m in config.get('Mounts',[]))
        for _ in range(100):
            if subprocess.run(['docker','exec',h.NAME,'pg_isready','-h','/tmp','-U','postgres'],capture_output=True,timeout=5).returncode==0: break
            time.sleep(.1)
        version=sql('show server_version_num;');assert 170000<=int(version)<180000; print('server_version_num='+version,flush=True)
        sql("""create role anon; create role authenticated; create role service_role;
        create schema auth; create table auth.users(id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
        create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
        create table websites(id uuid primary key,owner_id uuid,fqdn text);
        alter default privileges in schema public grant execute on functions to service_role;
        create table fixture_ledger(version text primary key,digest text);""")
        for path in sorted((ROOT/'supabase/migrations').glob('*forms*.sql')):
            if path==MIG: break
            source=path.read_text(); sql(source);sql(f"insert into fixture_ledger values('{path.name[:14]}','{hashlib.sha256(source.encode()).hexdigest()}');")
        before=acl(); protected=sql("select jsonb_agg(jsonb_build_array(oid::regprocedure::text,prosrc) order by oid) from pg_proc where oid in ('claim_form_delivery()'::regprocedure,'finish_form_delivery(uuid,uuid,text)'::regprocedure);")
        migration=MIG.read_text();print('producer_sha256='+hashlib.sha256(migration.encode()).hexdigest(),flush=True)
        # Guard rejects drift transactionally, restoring exact source/ACL afterward.
        for change,restore in [
            ('grant execute on function request_form_recipient(uuid,uuid,text) to authenticated;','revoke execute on function request_form_recipient(uuid,uuid,text) from authenticated;'),
            ("alter function confirm_form_recipient(uuid,text) set search_path=public;","alter function confirm_form_recipient(uuid,text) set search_path='';")]:
            sql(change); refused(migration,'notification_producer_');sql(restore)
            assert sql("select to_regprocedure('forms_notification_scope(uuid)') is null;")=='t'
        sql(migration);sql(f"insert into fixture_ledger values('20261209000000','{hashlib.sha256(migration.encode()).hexdigest()}');")
        assert json.loads(before)==[row for row in json.loads(acl()) if not row[0].startswith('forms_notification_scope(')]
        assert protected==sql("select jsonb_agg(jsonb_build_array(oid::regprocedure::text,prosrc) order by oid) from pg_proc where oid in ('claim_form_delivery()'::regprocedure,'finish_form_delivery(uuid,uuid,text)'::regprocedure);")
        assert sql("select string_agg(version,',' order by version) from fixture_ledger where version>='20261208000000';")=='20261208000000,20261209000000'
        print('PASS exact migration ledger order; drift rollback; existing ACLs/owners/config and claim/finish unchanged',flush=True)
        cases();print('RESULT: producer real-Forms-schema cases passed; no provider invoked',flush=True)
    finally:
        run('docker','rm','-f','-v',h.NAME);assert not run('docker','ps','-a','--filter','name='+h.NAME,'--format','{{.Names}}')
        print('CLEANUP: container removed; tmpfs discarded; no mounts/volumes/ports',flush=True)

if __name__=='__main__': main()
