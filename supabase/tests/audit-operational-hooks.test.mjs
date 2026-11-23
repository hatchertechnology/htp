import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile,readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
test('lease-validated completions alone open and recover operational episodes',async()=>{
 const db=new PGlite(),owner='00000000-0000-0000-0000-000000000001',site='00000000-0000-0000-0000-000000000002',lease='00000000-0000-0000-0000-000000000003',bad='00000000-0000-0000-0000-000000000004'
 try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$; grant usage on schema auth,public to authenticated,anon,service_role;`)
  const dir=new URL('../migrations/',import.meta.url)
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,dir),'utf8'))
  await db.query('insert into auth.users values($1)',[owner])
  await db.query("insert into public.websites(id,owner_id,fqdn) values($1,$2,'example.com')",[site,owner])
  await db.query("insert into public.google_connections(owner_id,encrypted_grant,scopes) values($1,'synthetic',array[]::text[])",[owner])
  await db.query("insert into public.bing_connections(owner_id,encrypted_grant) values($1,'synthetic')",[owner])
  const google=(await db.query("insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,lease,leased_until) values($1,'example.com','search','sc-domain:example.com','2026-01-01','2026-01-02',$2,now()+interval '1 hour') returning id",[site,lease])).rows[0].id
  const bing=(await db.query("insert into public.bing_report_jobs(website_id,fqdn,lease,leased_until) values($1,'example.com',$2,now()+interval '1 hour') returning id",[site,lease])).rows[0].id
  const repo=(await db.query("insert into public.website_repositories(website_id,fqdn,repository_url,lease,leased_until) values($1,'example.com','https://github.com/example/site',$2,now()+interval '1 hour') returning id",[site,lease])).rows[0].id
  const googleGen=(await db.query('select generation from public.google_connections where owner_id=$1',[owner])).rows[0].generation
  const bingGen=(await db.query('select generation from public.bing_connections where owner_id=$1',[owner])).rows[0].generation
  const complete=async(source,l,outcome)=>{
   if(source==='google') return (await db.query('select public.complete_google_report($1,$2,$3,$4,$5) ok',[google,l,googleGen,outcome==='success'?{}:null,outcome==='success'?null:'google_quota_exceeded'])).rows[0].ok
   if(source==='bing') return (await db.query('select public.complete_bing_report($1,$2,$3,$4,$5) ok',[bing,l,bingGen,outcome==='success'?{}:null,outcome==='success'?null:'bing_unavailable'])).rows[0].ok
   return (await db.query('select public.complete_website_repository($1,$2,$3,$4,$5,$6,$7) ok',[repo,l,outcome==='success'?[]:null,null,true,outcome==='success'?null:'private raw error',3600])).rows[0].ok
  }
  for(const source of ['google','bing','repository']) assert.equal(await complete(source,bad,'fail'),false)
  assert.equal(await complete('google',lease,'fail'),true)
  assert.equal((await db.query('select count(*)::int n from public.audit_operational_episodes')).rows[0].n,0,'gate off')
  await db.exec('update public.audit_event_config set operations_enabled=true')
  const tables={google:'google_report_jobs',bing:'bing_report_jobs',repository:'website_repositories'}, ids={google,bing,repository:repo}
  for(const source of ['google','bing','repository']) {
   const table=tables[source],id=ids[source]
   await db.query(`update public.${table} set lease=$1,leased_until=now()+interval '1 hour' where id=$2`,[lease,id])
   assert.equal(await complete(source,lease,'fail'),true)
   const episode=(await db.query('select id,recovered_at,error_class from public.audit_operational_episodes where source=$1',[source])).rows[0]
   assert.ok(episode.id);assert.equal(episode.recovered_at,null)
   await db.query(`update public.${table} set last_error=null,lease=$1,leased_until=now()+interval '1 hour' where id=$2`,[lease,id])
   assert.equal((await db.query('select recovered_at from public.audit_operational_episodes where id=$1',[episode.id])).rows[0].recovered_at,null,'reset is not recovery')
   assert.equal(await complete(source,lease,'fail'),true)
   assert.equal((await db.query('select count(*)::int n from public.audit_operational_episodes where source=$1',[source])).rows[0].n,1,'retry deduplicates')
   await db.query(`update public.${table} set lease=$1,leased_until=now()+interval '1 hour' where id=$2`,[lease,id])
   assert.equal(await complete(source,lease,'success'),true)
   assert.ok((await db.query('select recovered_at from public.audit_operational_episodes where id=$1',[episode.id])).rows[0].recovered_at)
  }
  assert(!JSON.stringify((await db.query('select * from public.audit_operational_episodes')).rows).includes('private raw error'))
 } finally {await db.close()}
})
