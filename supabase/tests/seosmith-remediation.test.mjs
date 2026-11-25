import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const owner='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003', run='00000000-0000-0000-0000-000000000004'
test('work is owner-scoped, tied to an immutable finding, and verification does not change evidence', async()=>{
 const db=new PGlite()
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$; create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$; grant usage on schema auth,public to anon,authenticated,service_role;`)
  for(const f of ['20261028142440_create_websites.sql','20261031053344_seosmith_audits.sql','20261202000000_seosmith_remediation.sql']) await db.exec(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'))
  const funcs=['seosmith_remediation_list(uuid,uuid,integer,timestamptz,uuid)','seosmith_remediation_save(uuid,uuid,integer,jsonb)','seosmith_remediation_attempt(uuid,uuid,uuid,text,text)']
  for(const role of ['anon','authenticated','service_role']) for(const f of funcs) assert.equal((await db.query("select has_function_privilege($1,$2,'execute') allowed",[role,'public.'+f])).rows[0].allowed,false)
  // Synthetic authorization only; the migration itself keeps these held.
  for(const f of funcs) await db.exec(`grant execute on function public.${f} to authenticated`)
  await db.query('insert into auth.users values($1),($2)',[owner,other]); await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner])
  const report={schema_version:1,findings:[{key:'finding-a',rule:'missing_title',severity:'warning',url:'https://example.com/',evidence:'missing'}]}
  await db.query("insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report) values($1,$2,'example.com',1,$3,$4)",[run,site,'a'.repeat(64),report])
  const identity=async(user,anonymous=false)=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,is_anonymous:anonymous})])}
  const save=(idx,work)=>db.query('select public.seosmith_remediation_save($1,$2,$3,$4) as work',[site,run,idx,work])
  await db.exec('set role anon');await assert.rejects(()=>save(0,{}),/permission denied/);await identity(other);await assert.rejects(()=>save(0,{}),/forbidden/)
  await identity(owner,true);await assert.rejects(()=>save(0,{}),/forbidden/)
  await identity(owner);await assert.rejects(()=>save(1,{}),/invalid_audit_or_finding/);await assert.rejects(()=>save(0,{status:'verified'}),/invalid_work/);await assert.rejects(()=>save(0,{segments:{locale:[]}}),/invalid_work/);await assert.rejects(()=>save(0,{segments:{invented:'x'}}),/invalid_work/)
  await db.exec('reset role'); await db.query("update public.seosmith_audits set report=$1 where delivery_id=$2",[{findings:[{key:'x'}]},run]); await identity(owner); await assert.rejects(()=>save(0,{}),/invalid_audit_or_finding/); await db.exec('reset role'); await db.query("update public.seosmith_audits set report=$1 where delivery_id=$2",[report,run]); await identity(owner)
  // Save an actual schema 2 fixture in the same audit table and bind its original ordinal.
  const v2=JSON.parse(await readFile(new URL('./fixtures/contracts/v2-partial.json',import.meta.url),'utf8'))
  const run2='00000000-0000-0000-0000-000000000005'
  await db.exec('reset role'); await db.query("insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report) values($1,$2,'example.com',1,$3,$4)",[run2,site,'b'.repeat(64),v2]); await identity(owner)
  assert.ok(v2.findings.length)
  const bound=(await db.query('select public.seosmith_remediation_save($1,$2,0,$3) as work',[site,run2,{status:'open'}])).rows[0].work
  assert.equal(bound.finding_key,v2.findings[0].key); assert.equal(bound.finding_index,0)
  const edited=(await db.query('select public.seosmith_remediation_save($1,$2,0,$3) as work',[site,run2,{status:'in_progress',notes:'Owner edit'}])).rows[0].work
  assert.equal(edited.id,bound.id); assert.equal(edited.notes,'Owner edit')
  await identity(other); await assert.rejects(()=>db.query('select public.seosmith_remediation_save($1,$2,0,$3)',[site,run2,{status:'done'}]),/forbidden/); await identity(owner)
  const first=(await save(0,{status:'done',assignee:'Editor',segments:{locale:'en'},notes:'Changed title'})).rows[0].work
  assert.equal(first.finding_key,'finding-a');assert.equal(first.business_exposure,null)
  const attempt=(await db.query('select public.seosmith_remediation_attempt($1,$2,$3,$4,$5) as attempt',[site,first.id,run,'unverified','Awaiting another crawl'])).rows[0].attempt
  assert.equal(attempt.result,'unverified');await identity(other);await assert.rejects(()=>db.query('select public.seosmith_remediation_attempt($1,$2,$3,$4,$5)',[site,first.id,run,'observed','forged']),/forbidden/);await identity(owner)
  const listed=(await db.query('select public.seosmith_remediation_list($1,$2,0,null,null) as work',[site,run])).rows[0].work
  assert.equal(listed[0].attempts.length,1); assert.equal(listed[0].status,'done')
  await db.exec('reset role'); await db.query("insert into public.seosmith_verification_attempts(remediation_id,result,note) select $1,'unverified','another check' from generate_series(1,50)",[first.id]); await identity(owner)
  const page1=(await db.query('select public.seosmith_remediation_list($1,$2,0,null,null) as work',[site,run])).rows[0].work[0]
  await db.query('select public.seosmith_remediation_attempt($1,$2,$3,$4,$5)',[site,first.id,run,'unverified','inserted during paging'])
  const last=page1.attempts.at(-1); const page2=(await db.query('select public.seosmith_remediation_list($1,$2,0,$3,$4) as work',[site,run,last.created_at,last.id])).rows[0].work[0]
  assert.equal(page1.attempts.length,50); assert.equal(page1.attempts_more,true); assert.equal(page2.attempts.length,1); assert.equal(page2.attempts_more,false)
  assert.equal(new Set([...page1.attempts,...page2.attempts].map(x=>x.id)).size,51)
  await db.exec('reset role');assert.deepEqual((await db.query('select report from public.seosmith_audits where delivery_id=$1',[run])).rows[0].report,report)
  await db.query("update public.websites set fqdn='changed.example.com' where id=$1",[site]);await identity(owner);await assert.rejects(()=>save(0,{}),/invalid_audit_or_finding/);await assert.rejects(()=>db.query('select public.seosmith_remediation_list($1,$2,0,null,null)',[site,run]),/audit_not_found/)
 } finally {await db.close()}
})

// S14 schema 4 (E-db): seosmith_remediation_save accepts schema 4 and still rejects other schemas.
test('remediation_save accepts a schema-4 finding, binds its key and keeps rejecting unknown schemas',async()=>{
 const db=new PGlite()
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$; create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$; grant usage on schema auth,public to anon,authenticated,service_role;`)
  for(const f of ['20261028142440_create_websites.sql','20261031053344_seosmith_audits.sql','20261202000000_seosmith_remediation.sql']) await db.exec(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'))
  // The base audits table predates these columns; E-db's helper and index function read them.
  await db.exec('alter table public.seosmith_audits add column if not exists summary jsonb, add column if not exists scan_at timestamptz, add column if not exists ingestion_source text')
  const acl=()=>db.query("select proacl::text a from pg_proc where proname='seosmith_remediation_save'").then(r=>r.rows[0].a)
  const before=await acl()
  await db.exec(await readFile(new URL('../migrations/20261212000000_s14_schema4_evidence.sql',import.meta.url),'utf8'))
  assert.equal(await acl(),before,'E-db keeps the held ACL')
  for(const f of ['seosmith_remediation_save(uuid,uuid,integer,jsonb)']) for(const role of ['anon','authenticated','service_role']) assert.equal((await db.query("select has_function_privilege($1,$2,'execute') allowed",[role,'public.'+f])).rows[0].allowed,false)
  await db.exec('grant execute on function public.seosmith_remediation_save(uuid,uuid,integer,jsonb) to authenticated') // synthetic authorization only
  await db.query('insert into auth.users values($1)',[owner]); await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner])
  const finding={key:'s4-finding-a',rule:'missing_title',severity:'warning',url:'https://example.com/',evidence:'missing'}
  const put=(n,report)=>db.query("insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report) values($1,$2,'example.com',1,$3,$4)",[`00000000-0000-0000-0000-0000000001${n}0`,site,String(n).repeat(64),report])
  const did=n=>`00000000-0000-0000-0000-0000000001${n}0`
  await put(4,{schema_version:'4',findings:[finding],evidence_contract:{version:1}}); await put(3,{schema_version:'3',findings:[finding]}); await put(1,{schema_version:1,findings:[finding]}); await put(2,{schema_version:2,findings:[finding]})
  await db.exec('reset role;set role authenticated'); await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})])
  const save=(n,idx=0,work={status:'in_progress',notes:'schema 4 work'})=>db.query('select public.seosmith_remediation_save($1,$2,$3,$4) as work',[site,did(n),idx,work]).then(r=>r.rows[0].work)
  const w=await save(4); assert.equal(w.finding_key,'s4-finding-a'); assert.equal(w.finding_index,0); assert.equal(w.status,'in_progress')
  assert.equal((await save(4,0,{status:'done'})).id,w.id,'second save updates the same row')
  await assert.rejects(()=>save(4,1),/invalid_audit_or_finding/)
  await assert.rejects(()=>save(3),/invalid_audit_or_finding/)
  assert.equal((await save(1)).finding_key,'s4-finding-a'); assert.equal((await save(2)).finding_key,'s4-finding-a')
 } finally {await db.close()}
})
