"""Offline PG17 queue successor fixture; reuses exact fenced baseline harness.
No network/pulls/mounts/provider. Synthetic minimal schema, not full catalog.
"""
import importlib.util
import hashlib
from pathlib import Path

spec = importlib.util.spec_from_file_location('baseline', Path(__file__).with_name('forms-delivery-scoped-claim-local.py'))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
source = (b.ROOT / 'supabase/migrations/20261210000000_forms_notification_queue_maintenance.sql').read_text()
base_sql = b.sql
installed = False


def sql(s):
    global installed
    result = base_sql(s)
    if '-- Worker fence only.' in s and not installed:
        base_sql(source)
        installed = True
        print('maintenance_sha256=' + hashlib.sha256(source.encode()).hexdigest(), flush=True)
    return result


b.sql = sql
original_concurrency = b.concurrency
u = b.uid


def reconcile(g=8, site=1, owner=2, limit=64):
    return sql(f"select reconcile_form_delivery_scope('{u(7)}','{u(site)}','{u(owner)}','{u(g)}',{limit});")


def extra():
    original_concurrency()
    b.setup()
    sql(f"""insert into websites values ('{u(20)}','{u(21)}');
      insert into forms_notification_admissions values ('{u(22)}','{u(20)}','{u(21)}','{u(23)}',true);
      update forms_notification_schedule set website_cursor='{u(1)}' where slot=0;""")
    assert b.claim() is None  # invalid second scope consumes only one visit
    assert b.claim()['id'] == u(5)  # cyclic return to eligible first scope
    print('PASS cyclic scopes cannot starve eligible site behind invalid scope', flush=True)
    b.setup()
    sql('update forms_notification_schedule set job_cursor=null where slot=1;')
    # 130 invalid jobs precede the valid job in UUID order: bounded batches
    # advance on invalidity instead of repeatedly scanning the same prefix.
    sql(f"""delete from forms_notification_job_admissions;
      update website_form_delivery_jobs set id='{u(999)}' where id='{u(5)}';
      insert into website_form_recipients values ('{u(10)}','{u(1)}','{u(3)}','invalid@example.invalid',false,null,now());
      insert into website_form_delivery_jobs(id,recipient_id,kind,secret_token)
        select ('00000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'{u(10)}','verification','synthetic'
        from generate_series(100,229) i;
      insert into forms_notification_job_admissions
        select id,'{u(7)}','{u(1)}','{u(2)}','{u(8)}' from website_form_delivery_jobs;""")
    assert b.claim() is None
    assert sql(f"select job_cursor='{u(163)}' from forms_notification_schedule where slot=1 and website_cursor='{u(1)}';") == 't'
    assert b.claim() is None
    job = b.claim()
    assert job['id'] == u(999)
    print('PASS bounded invalid prefix advances 64/64 then eligible lease', flush=True)
    assert reconcile(g=9) == '0'
    assert reconcile(site=20) == '0'
    assert reconcile(owner=20) == '0'
    assert reconcile(limit=3) == '3'
    assert sql("select count(*) from website_form_delivery_jobs where state='cancelled' and secret_token is null;") == '3'
    # Active lease remains finishable even with obsolete recipient/closed admission.
    sql('update forms_notification_admissions set active=false; update website_form_recipients set enabled=false;')
    reconcile()
    assert sql(f"select state='sending' and secret_token is not null from website_form_delivery_jobs where id='{u(999)}';") == 't'
    assert sql(f"select finish_form_delivery('{u(999)}','{job['lease']}','sent');") == 't'
    print('PASS exact scope/generation bounds and active matching finish preserved', flush=True)
    b.setup()
    job = b.claim()
    sql("update website_form_delivery_jobs set leased_until=now()-interval '1 second';")
    assert reconcile() == '1'
    assert b.finish(job['lease']) == 'f'
    b.check('expired uncertainty retains evidence clears secret', f"state='uncertain' and secret_token is null and lease='{job['lease']}' and attempts=1 from website_form_delivery_jobs")
    assert b.claim() is None
    assert reconcile() == '0'
    print('PASS no uncertain resend', flush=True)
    sql(f"""insert into website_form_recipients values
      ('{u(14)}','{u(11)}','{u(13)}','other@example.invalid',false,null,now());
      insert into website_form_delivery_jobs(id,recipient_id,kind,state,secret_token,lease,leased_until)
      values ('{u(15)}','{u(14)}','verification','sending','other-token','{u(16)}',now()-interval '1 day');
      insert into forms_notification_job_admissions values
      ('{u(15)}','{u(7)}','{u(1)}','{u(2)}','{u(8)}');""")
    assert reconcile() == '0'
    b.check('reconcile leaves other site evidence and secret intact', f"state='sending' and secret_token='other-token' and lease='{u(16)}' from website_form_delivery_jobs where id='{u(15)}'")
    b.setup()
    sql('update forms_notification_admissions set active=false;')
    assert reconcile() == '1'
    b.check('closed generation cancels pending verification', "state='cancelled' and secret_token is null from website_form_delivery_jobs")
    # Real conflict barriers: finish locks first; reconcile skips, then preserves sent.
    b.setup()
    job = b.claim()
    fin = b.Session('finish_first')
    fin.send(f"select finish_form_delivery('{u(5)}','{job['lease']}','sent');")
    assert fin.line() == 't'
    assert reconcile() == '0'
    fin.end()
    assert reconcile() == '0'
    # Reconcile locks first, finish waits then refuses expired attempt.
    b.setup()
    job = b.claim()
    fin = b.Session('finish_second')
    fin.send("select 'ready';")
    assert fin.line() == 'ready'
    # Finish retains its transaction timestamp from before expiry. Reconcile
    # uses wall time; after its update finish must recheck state under the lock.
    sql("update website_form_delivery_jobs set leased_until=(select xact_start+interval '1 millisecond' from pg_stat_activity where application_name='finish_second');")
    rec = b.Session('reconcile_first')
    rec.send(f"select reconcile_form_delivery_scope('{u(7)}','{u(1)}','{u(2)}','{u(8)}',64);")
    assert rec.line() == '1'
    fin.send(f"select finish_form_delivery('{u(5)}','{job['lease']}','sent');")
    b.blocked('finish_second')
    assert b.claim() is None
    rec.end()
    assert fin.line() == 'f'
    fin.end()
    print('PASS claim/finish/reconcile conflict barriers', flush=True)


b.concurrency = extra
if __name__ == '__main__':
    b.main()
