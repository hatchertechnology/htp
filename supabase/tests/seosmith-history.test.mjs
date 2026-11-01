import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
const owner='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000003'
const rid = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
function report(id, overrides={}) { return {schema_version:1,engine_version:'0.1.0',ruleset_version:'2026-10-31.1',request:{request_id:rid(id),website_id:rid(99),binding_generation:1,url:'https://example.com/',max_pages:500},started_at:'2026-10-31T01:00:00Z',finished_at:'2026-10-31T01:10:00Z',outcome:'completed',stop_reason:'frontier_exhausted',coverage_complete:true,pages:[{url:'https://example.com/',status:200,content_type:'text/html',error:null},{url:'https://example.com/a.jpg',status:404,content_type:'image/jpeg',error:null}],findings:[{key:'a',rule:'http_client_error',severity:'critical',url:'https://example.com/a.jpg',evidence:'404'}],...overrides} }
test('audit history preserves every run, scan timestamps, summaries, immutable bytes, tied cursors, and owner isolation', async()=>{
 const db = new PGlite()
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;grant usage on schema auth,public to authenticated,anon,service_role;`)
  await db.exec('alter default privileges grant execute on functions to anon,authenticated;')
  for(const f of ['20261028142440_create_websites.sql','20261031053344_seosmith_audits.sql','20261031053413_seosmith_history.sql','20261031053524_seosmith_explicit_function_privileges.sql','20261101052410_seosmith_expanded_evidence.sql']) await db.exec(await readFile(new URL('../migrations/'+f,import.meta.url),'utf8'))
  const grants = await db.query("select has_function_privilege('anon','public.import_seosmith_audit(uuid,text)','execute') as anon_import, has_function_privilege('anon','public.seosmith_audit_history(uuid,integer,timestamptz,uuid)','execute') as anon_history, has_function_privilege('anon','public.ingest_seosmith_audit(text,uuid,text,text)','execute') as worker_ingest");assert.deepEqual(grants.rows[0],{anon_import:false,anon_history:false,worker_ingest:true})
  await db.query('insert into auth.users values($1),($2)',[owner,other]);await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner])
  const identity=async(user,anonymous=false)=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,is_anonymous:anonymous})])}
  const save=r=>db.query('select public.import_seosmith_audit($1,$2) as receipt',[site,JSON.stringify(r,null,2)])
  const history=(limit=50,before=null,id=null)=>db.query('select public.seosmith_audit_history($1,$2,$3,$4) as history',[site,limit,before,id]).then(x=>x.rows[0].history)
  await identity(other);await assert.rejects(()=>save(report(10)),/forbidden/)
  await identity(owner,true);await assert.rejects(()=>save(report(10)),/forbidden/)
  await identity(owner)
  await assert.rejects(()=>save(report(10,{request:{...report(10).request,url:'https://other.example/'}})),/hostname_mismatch/)
  await save(report(10));await save(report(11,{outcome:'partial',coverage_complete:false,stop_reason:'page_limit'}));await save(report(12,{finished_at:'2026-10-30T01:10:00Z',started_at:'2026-10-30T01:00:00Z',findings:[]}))
  await save(report(10));const all=await history();assert.equal(all.items.length,3);assert.equal(all.items[0].delivery_id,rid(11));assert.equal(all.items[0].summary.coverage_complete,false)
  assert.equal(all.items[1].summary.pages.http_errors,1);assert.equal(all.items[1].summary.severities.critical,1);assert.equal(all.items[1].summary.rules.http_client_error,1);assert.equal(all.items[1].summary.findings,1)
  assert.equal(all.items[2].summary.findings,0,'zero findings remain a real zero');assert.equal(all.items[2].scan_at.slice(0,10),'2026-10-30','backfills plot by scan time, not ingestion')
  assert(!('report' in all.items[0]),'history returns compact summaries')
  const first=await history(1);const second=await history(1,first.next_cursor.before,first.next_cursor.before_id);assert.notEqual(first.items[0].delivery_id,second.items[0].delivery_id,'same-time cursors do not skip a run')
  const detail=(await db.query('select public.seosmith_audit_detail($1,$2) as detail',[site,rid(10)])).rows[0].detail
  assert.equal(detail.report_json,JSON.stringify(report(10),null,2));assert.equal(detail.report.request.website_id,rid(99),'original local-only ID preserved')
  await assert.rejects(()=>save(report(10,{findings:[]})),/delivery_conflict/)
  await assert.rejects(()=>save(report(13,{finished_at:'2026-10-29T00:00:00Z'})),/invalid_scan_dates/)
  await assert.rejects(()=>save(report(14,{findings:[{severity:'nonsense'}]})),/invalid_seosmith_findings/)
  await db.exec('reset role');await assert.rejects(()=>db.query("update public.seosmith_audits set report='{}' where delivery_id=$1",[rid(10)]),/audit_is_immutable/)
  const token='q'.repeat(64);await db.query('insert into public.seosmith_bindings(website_id,token_sha256) values($1,$2)',[site,createHash('sha256').update(token).digest('hex')]);const pushed=report(20);pushed.request.website_id=site;const bytes=JSON.stringify(pushed)
  await db.exec('set role anon');await db.query('select public.ingest_seosmith_audit($1,$2,$3,$4)',[token,rid(20),createHash('sha256').update(bytes).digest('hex'),bytes]);await identity(owner);assert.equal((await history()).items.length,4)
  await identity(other);await assert.rejects(()=>history(),/forbidden/);await assert.rejects(()=>db.query('select public.seosmith_audit_detail($1,$2)',[site,rid(10)]),/forbidden/)
  await db.exec('reset role');await db.query("update public.websites set fqdn='new.example.com' where id=$1",[site]);await identity(owner);assert.equal((await history()).items.length,0)
 } finally {await db.close()}
})
