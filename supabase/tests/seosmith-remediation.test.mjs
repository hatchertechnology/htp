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
  await db.query('insert into auth.users values($1),($2)',[owner,other]); await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner])
  const report={schema_version:1,findings:[{key:'finding-a',rule:'missing_title',severity:'warning',url:'https://example.com/',evidence:'missing'}]}
  await db.query("insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report) values($1,$2,'example.com',1,$3,$4)",[run,site,'a'.repeat(64),report])
  const identity=async(user,anonymous=false)=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,is_anonymous:anonymous})])}
  const save=(idx,work)=>db.query('select public.seosmith_remediation_save($1,$2,$3,$4) as work',[site,run,idx,work])
  await db.exec('set role anon');await assert.rejects(()=>save(0,{}),/permission denied/);await identity(other);await assert.rejects(()=>save(0,{}),/forbidden/)
  await identity(owner,true);await assert.rejects(()=>save(0,{}),/forbidden/)
  await identity(owner);await assert.rejects(()=>save(1,{}),/invalid_audit_or_finding/);await assert.rejects(()=>save(0,{status:'verified'}),/invalid_work/);await assert.rejects(()=>save(0,{segments:{locale:[]}}),/invalid_work/);await assert.rejects(()=>save(0,{segments:{invented:'x'}}),/invalid_work/)
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
