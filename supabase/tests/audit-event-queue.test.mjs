import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
test('queue is gated and atomic; reads enforce owner and hostname', async () => {
 const db=new PGlite(), owner='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000003',a='00000000-0000-0000-0000-000000000010',b='00000000-0000-0000-0000-000000000011',c='00000000-0000-0000-0000-000000000012'
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
   create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create function auth.uid() returns uuid language sql as $$select (auth.jwt()->>'sub')::uuid$$;
   create table public.websites(id uuid primary key,owner_id uuid,fqdn text);
   create table public.seosmith_audits(delivery_id uuid primary key,website_id uuid,fqdn text,generation bigint,ingestion_source text,summary jsonb);
   create table public.google_report_jobs(id uuid primary key,website_id uuid,fqdn text);
   create table public.bing_report_jobs(id uuid primary key,website_id uuid,fqdn text);
   create table public.website_repositories(id uuid primary key,website_id uuid,fqdn text);
   grant usage on schema public,auth to authenticated,anon;`)
  await db.exec(await readFile(new URL('../migrations/20261203000000_audit_event_queue.sql',import.meta.url),'utf8'))
  await db.query('insert into public.websites values($1,$2,$3)',[site,owner,'example.com'])
  await db.query('insert into public.google_report_jobs values($1,$2,$3)',[a,site,'example.com'])
  const operation=(outcome,error=null)=>db.query('select public.audit_operational_completion($1,$2,$3,$4,$5,$6) id',[site,'example.com','google',a,outcome,error]).then(r=>r.rows[0].id)
  assert.equal(await operation('failed','other'),null)
  await db.exec('update public.audit_event_config set operations_enabled=true')
  const episode=await operation('failed','other'); assert.ok(episode)
  assert.equal(await operation('failed','other'),episode)
  assert.equal(await operation('recovered'),episode)
  assert.notEqual(await operation('failed','other'),episode)
  await assert.rejects(()=>operation('failed','raw secret'),/invalid_operation/)
  await assert.rejects(()=>db.query('select public.audit_operational_completion($1,$2,$3,$4,$5,$6)',[site,'other.example','google',a,'failed','other']),/invalid_scope/)

  const insert=(id,source='worker',schema=2)=>db.query('insert into public.seosmith_audits values($1,$2,$3,1,$4,$5)',[id,site,'example.com',source,{schema_version:schema}])
  await insert(a); assert.equal((await db.query('select count(*)::int n from public.audit_event_jobs')).rows[0].n,0)
  await db.exec('update public.audit_event_config set enqueue_enabled=true')
  await insert(b); await insert(c,'import')
  assert.equal((await db.query('select public.audit_event_claim() c')).rows[0].c,null)
  await db.exec('update public.audit_event_config set processing_enabled=true')
  const claim=(await db.query('select public.audit_event_claim() c')).rows[0].c
  assert.equal(claim.delivery_id,b)
  assert.equal((await db.query('select public.audit_event_claim() c')).rows[0].c,null)
  assert.equal((await db.query("select public.audit_event_hold($1,$2,'history_unknown') ok",[b,claim.lease_token])).rows[0].ok,true)
  assert.equal((await db.query("select public.audit_event_hold($1,$2,'history_unknown') ok",[b,claim.lease_token])).rows[0].ok,false)
  assert.deepEqual((await db.query('select delivery_id from public.audit_event_jobs')).rows,[{delivery_id:b}])
  await db.query('insert into public.seosmith_audits values($1,$2,$3,1,$4,$5) on conflict do nothing',[b,site,'example.com','worker',{schema_version:2}])
  assert.equal((await db.query('select count(*)::int n from public.audit_event_jobs')).rows[0].n,1)
  await db.exec("create function public.fail_queue() returns trigger language plpgsql as $$begin raise exception 'queue failure'; end$$; create trigger fail_queue before insert on public.audit_event_jobs for each row execute function public.fail_queue()")
  await assert.rejects(()=>insert('00000000-0000-0000-0000-000000000014'),/queue failure/)
  assert.equal((await db.query("select count(*)::int n from public.seosmith_audits where delivery_id='00000000-0000-0000-0000-000000000014'")).rows[0].n,0)
  await db.query("insert into public.audit_events(website_id,fqdn,generation,delivery_id,baseline_id,semantics_version,entity_id,rule,kind,severity,source_locator) values($1,'example.com',1,$2,$3,1,'entity','rule','new','warning','/evaluations/0')",[site,b,a])
  await db.query("insert into public.audit_events(website_id,fqdn,generation,delivery_id,baseline_id,semantics_version,entity_id,rule,kind,severity,source_locator) values($1,'example.com',1,$2,$3,1,'entity2','rule','new','warning','/evaluations/1')",[site,b,a])
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})]); await db.exec('set role authenticated')
  let result=(await db.query('select public.audit_event_history($1) h',[site])).rows[0].h
  assert.equal(result.availability,'producer_unavailable'); assert.equal(result.events.length,2)
  const first=(await db.query('select public.audit_event_history($1,1) h',[site])).rows[0].h
  assert.equal(first.has_more,true); const secondPage=(await db.query('select public.audit_event_history($1,1,$2,$3) h',[site,first.next_cursor.before,first.next_cursor.before_id])).rows[0].h
  assert.equal(secondPage.has_more,false); assert.notEqual(first.events[0].id,secondPage.events[0].id)
  await assert.rejects(()=>db.query('select public.audit_event_history($1,1,now(),null)',[site]),/invalid_cursor_or_limit/)
  const operations=(await db.query('select public.audit_operational_history($1) h',[site])).rows[0].h
  assert.equal(operations.availability,'producer_unavailable'); assert.equal(operations.episodes.length,2)
  const firstOps=(await db.query('select public.audit_operational_history($1,1) h',[site])).rows[0].h
  const nextOps=(await db.query('select public.audit_operational_history($1,1,$2,$3) h',[site,firstOps.next_cursor.before,firstOps.next_cursor.before_id])).rows[0].h
  assert.notEqual(firstOps.episodes[0].id,nextOps.episodes[0].id)
  await assert.rejects(()=>db.query('select * from public.audit_events'),/permission denied/)
  await assert.rejects(()=>db.query('select public.audit_event_claim()'),/permission denied/)
  await assert.rejects(()=>db.query("select public.audit_operational_completion($1,'example.com','google',$2,'failed','other')",[site,a]),/permission denied/)
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:other,is_anonymous:false})])
  await assert.rejects(()=>db.query('select public.audit_event_history($1)',[site]),/forbidden/)
  await assert.rejects(()=>db.query('select public.audit_operational_history($1)',[site]),/forbidden/)
  await db.exec('reset role'); await db.query("update public.websites set fqdn='new.example.com' where id=$1",[site])
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})]); await db.exec('set role authenticated')
  result=(await db.query('select public.audit_event_history($1) h',[site])).rows[0].h; assert.deepEqual(result.events,[])
 } finally {await db.close()}
})

test('real receiver and import keep immutable receipts and enqueue worker once', async () => {
 const {createHash}=await import('node:crypto'), hash=s=>createHash('sha256').update(s).digest('hex')
 const db=new PGlite(),owner='00000000-0000-0000-0000-000000000001'
 const report=JSON.parse(await readFile(new URL('./fixtures/contracts/v2-complete.json',import.meta.url),'utf8'))
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
   grant usage on schema auth,public to authenticated,anon,service_role; alter default privileges grant execute on functions to anon,authenticated;`)
  for(const name of ['20261028142440_create_websites.sql','20261031053344_seosmith_audits.sql','20261031053413_seosmith_history.sql','20261031053524_seosmith_explicit_function_privileges.sql','20261101054016_seosmith_expanded_evidence.sql','20261101060006_seosmith_policy_exclusions.sql','20261116210550_seosmith_versioned_receiver.sql','20261116221958_seosmith_summary_target_lookup.sql','20261116223631_h01_scanner_budget.sql','20261116224641_seosmith_summary_compact_input.sql']) await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'))
  if (process.env.HTP_LIFECYCLE_MIGRATION_PATH) await db.exec(await readFile(process.env.HTP_LIFECYCLE_MIGRATION_PATH,'utf8'))
  await db.exec(await readFile(new URL('../migrations/20261203000000_audit_event_queue.sql',import.meta.url),'utf8'))
  await db.query('insert into auth.users values($1)',[owner])
  await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[report.request.website_id,owner])
  const token='x'.repeat(64)
  await db.query('insert into public.seosmith_bindings(website_id,token_sha256) values($1,$2)',[report.request.website_id,hash(token)])
  await db.exec('update public.audit_event_config set enqueue_enabled=true; set role anon')
  const raw=JSON.stringify(report), id=report.request.request_id
  const push=()=>db.query('select public.ingest_seosmith_audit($1,$2,$3,$4) r',[token,id,hash(raw),raw]).then(x=>x.rows[0].r)
  const first=await push(); assert.deepEqual(await push(),first)
  await db.exec('reset role')
  assert.equal((await db.query('select count(*)::int n from public.audit_event_jobs')).rows[0].n,1)
  if (process.env.HTP_LIFECYCLE_MIGRATION_PATH) {
    assert.equal((await db.query('select state from public.seosmith_lifecycle_indexed where delivery_id=$1',[id])).rows[0].state,'indexed_v1')
    await db.exec('update public.audit_event_config set processing_enabled=true')
    const claim=(await db.query('select public.audit_event_claim() c')).rows[0].c
    await db.exec('begin');await db.query('select public.audit_event_snapshot_lock()')
    assert.equal((await db.query('select public.audit_event_process($1,$2) r',[id,claim.lease_token])).rows[0].r,'held');await db.exec('commit')
    assert.equal((await db.query('select hold_reason from public.audit_event_jobs where delivery_id=$1',[id])).rows[0].hold_reason,'history_unknown')
    const next=structuredClone(report)
    next.request.request_id='00000000-0000-4000-8000-000000000008'
    next.started_at='2026-11-17T12:00:00Z'; next.finished_at='2026-11-17T12:01:00Z'
    next.evidence_contract.observed_at.started_at=next.started_at; next.evidence_contract.observed_at.finished_at=next.finished_at
    const nextRaw=JSON.stringify(next)
    await db.exec('set role anon')
    await db.query('select public.ingest_seosmith_audit($1,$2,$3,$4)',[token,next.request.request_id,hash(nextRaw),nextRaw])
    await db.exec('reset role')
    const second=(await db.query('select public.audit_event_claim() c')).rows[0].c
    await db.exec('begin');await db.query('select public.audit_event_snapshot_lock()')
    assert.equal((await db.query('select public.audit_event_process($1,$2) r',[next.request.request_id,second.lease_token])).rows[0].r,'processed');await db.exec('commit')
    assert.equal((await db.query('select count(*)::int n from public.audit_events')).rows[0].n,0)
  }
  assert.equal((await db.query('select raw_report_json from public.seosmith_audits where delivery_id=$1',[id])).rows[0].raw_report_json,raw)
  report.request.request_id='00000000-0000-4000-8000-000000000009'
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})]);await db.exec('set role authenticated')
  await db.query('select public.import_seosmith_audit($1,$2)',[report.request.website_id,JSON.stringify(report)])
  await db.exec('reset role')
  assert.equal((await db.query('select count(*)::int n from public.audit_event_jobs')).rows[0].n,process.env.HTP_LIFECYCLE_MIGRATION_PATH?2:1)
 } finally {await db.close()}
})

test('processor requires lock and lease and holds missing or ambiguous evidence', async () => {
 const db=new PGlite(),site='00000000-0000-0000-0000-000000000021',owner='00000000-0000-0000-0000-000000000022',old='00000000-0000-0000-0000-000000000023',current='00000000-0000-0000-0000-000000000024'
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
   create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$; create function auth.uid() returns uuid language sql as $$select null::uuid$$;
   create table public.websites(id uuid primary key,owner_id uuid,fqdn text);
   create table public.seosmith_audits(delivery_id uuid primary key,website_id uuid,fqdn text,generation bigint,ingestion_source text,summary jsonb,scan_at timestamptz,report jsonb);
   create table public.seosmith_lifecycle_indexed(delivery_id uuid primary key,state text,evidence_truncated boolean,policy_digest text,comparison_key text,engine_version text,ruleset_version text);
   create table public.seosmith_lifecycle_evaluations(delivery_id uuid,entity_id text,rule text,evaluation jsonb,primary key(delivery_id,entity_id,rule));`)
  await db.exec(await readFile(new URL('../migrations/20261203000000_audit_event_queue.sql',import.meta.url),'utf8'))
  await db.query("insert into public.websites values($1,$2,'example.com')",[site,owner])
  await db.exec('update public.audit_event_config set enqueue_enabled=true,processing_enabled=true')
  const add=(id,time,outcome)=>db.query('insert into public.seosmith_audits values($1,$2,$3,1,$4,$5,$6,$7)',[id,site,'example.com','worker',{schema_version:2},time,{findings:outcome==='fail'?[{key:'f',severity:'warning'}]:[]}])
  await add(old,'2026-11-01T00:00:00Z','pass'); await add(current,'2026-11-02T00:00:00Z','fail')
  await db.query("update public.audit_event_jobs set state='held',hold_reason='history_unknown' where delivery_id=$1",[old])
  for(const id of [old,current]) await db.query("insert into public.seosmith_lifecycle_indexed values($1,'indexed_v1',false,'policy','key','engine','rules')",[id])
  const evaluation=outcome=>({eligibility:'eligible',attempt:'completed',outcome,rule_version:'1',validator_version:'1',source_locator:'/evaluations/0',finding_key:outcome==='fail'?'f':null})
  await db.query('insert into public.seosmith_lifecycle_evaluations values($1,$2,$3,$4)',[old,'entity','rule',evaluation('pass')]);await db.query('insert into public.seosmith_lifecycle_evaluations values($1,$2,$3,$4)',[current,'entity','rule',evaluation('fail')])
  const claim=(await db.query('select public.audit_event_claim() c')).rows[0].c
  await assert.rejects(()=>db.query('select public.audit_event_process($1,$2)',[current,claim.lease_token]),/snapshot_lock_required/)
  await db.exec('begin'); await db.query('select public.audit_event_snapshot_lock()');
  assert.equal((await db.query('select public.audit_event_process($1,$2) r',[current,claim.lease_token])).rows[0].r,'processed'); await db.exec('commit')
  assert.equal((await db.query('select kind from public.audit_events')).rows[0].kind,'new')
  const unknown='00000000-0000-0000-0000-000000000025'
  await add(unknown,'2026-11-03T00:00:00Z','fail')
  await db.query("insert into public.seosmith_lifecycle_indexed values($1,'indexed_v1',false,'policy','key','engine','rules')",[unknown])
  await db.query('insert into public.seosmith_lifecycle_evaluations values($1,$2,$3,$4)',[unknown,'different-entity','rule',evaluation('fail')])
  const second=(await db.query('select public.audit_event_claim() c')).rows[0].c
  await db.exec('begin'); await db.query('select public.audit_event_snapshot_lock()')
  assert.equal((await db.query('select public.audit_event_process($1,$2) r',[unknown,second.lease_token])).rows[0].r,'held'); await db.exec('commit')
  assert.equal((await db.query('select hold_reason from public.audit_event_jobs where delivery_id=$1',[unknown])).rows[0].hold_reason,'history_unknown')
  assert.equal((await db.query('select count(*)::int n from public.audit_events')).rows[0].n,1)
  const tied='00000000-0000-0000-0000-000000000026'
  await add(tied,'2026-11-03T00:00:00Z','fail')
  await db.query("insert into public.seosmith_lifecycle_indexed values($1,'indexed_v1',false,'policy','key','engine','rules')",[tied])
  const third=(await db.query('select public.audit_event_claim() c')).rows[0].c
  await db.exec('begin'); await db.query('select public.audit_event_snapshot_lock()')
  assert.equal((await db.query('select public.audit_event_process($1,$2) r',[tied,third.lease_token])).rows[0].r,'held'); await db.exec('commit')
  assert.equal((await db.query('select hold_reason from public.audit_event_jobs where delivery_id=$1',[tied])).rows[0].hold_reason,'late_or_tied')
 } finally {await db.close()}
})
