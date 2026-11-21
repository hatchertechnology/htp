import { test } from 'node:test'
import assert from 'node:assert/strict'
import {readFile,readdir} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
test('exact snapshot freshness is independent of newer daily history and unrelated job errors',async()=>{
 const db=new PGlite();const owner='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002',site='00000000-0000-0000-0000-000000000003'
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;grant usage on schema auth,public to authenticated,anon,service_role;`)
  const dir=new URL('../migrations/',import.meta.url);for(const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(f,dir),'utf8'))
  await db.query('insert into auth.users values($1),($2)',[owner,other]); await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner]);
  await db.query("insert into public.google_connections(owner_id,encrypted_grant,scopes,status) values($1,'','{}','disconnected')",[owner]);
  const old=(await db.query("insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date) values($1,'example.com','search','sc-domain:example.com','2026-10-01','2026-10-03') returning id",[site])).rows[0].id
  const newer=(await db.query("insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,last_error) values($1,'example.com','search','sc-domain:example.com','2026-10-02','2026-10-04','google_quota_exceeded') returning id",[site])).rows[0].id
  const saved=await db.query("insert into public.google_report_snapshots(job_id,fetched_at,data) values($1,now()-interval '5 days',$2) returning id",[old,{queries:{rows:[{keys:['old'],clicks:1}]},daily:{rows:[]}}]);
  await db.query("insert into public.google_report_snapshots(job_id,fetched_at,data) values($1,now(),$2)",[newer,{daily:{rows:[{keys:['2026-10-02'],clicks:2,impressions:10}]}}]);
  const identity=async(id,anon=false)=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,is_anonymous:anon})])};
  const exact=async()=> (await db.query("select public.read_search_exact_snapshot($1,'search','sc-domain:example.com','2026-10-01','2026-10-03') r",[site])).rows[0].r;
  await identity(other);await assert.rejects(exact,/Website not found/);await identity(owner,true);await assert.rejects(exact,/Website not found/);await identity(owner)
  const result=await exact();const daily=(await db.query("select public.request_google_report($1,'search','sc-domain:example.com','2026-10-01','2026-10-03') r",[site])).rows[0].r
  assert.equal(result.sync.snapshot_id,Number(saved.rows[0].id));assert.equal(result.sync.state,'stale');assert.equal(result.data.queries.rows[0].keys[0],'old');assert.notEqual(result.sync.fetched_at,daily.sync.fetched_at);assert.equal(result.sync.last_error,undefined)
 }finally{await db.close()}
})
