import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('agent reads every saved source and complete snapshot, with isolated paginated history', async () => {
 const db = new PGlite()
 const owner='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003'
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
   create table auth.users(id uuid primary key);
   create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
   create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
   grant usage on schema auth,public to authenticated,anon,service_role;`)
  const dir = new URL('../migrations/',import.meta.url)
  for (const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,dir),'utf8'))
  await db.exec(`insert into auth.users values('${owner}'),('${other}');
   insert into public.websites(id,owner_id,fqdn,ga4_property_id) values('${site}','${owner}','example.com','123');
   insert into public.google_connections(owner_id,encrypted_grant,scopes) values('${owner}','SECRET',array[]::text[]);
   insert into public.website_business_locations(website_id,fqdn,location_id) values('${site}','example.com','locations/1');`)
  const kinds=['analytics','search','properties','conversions','pagespeed','crux','business_locations','business_profile','business_performance']
  for (const kind of kinds) {
   const job=(await db.query(`insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,last_error)
    values($1,'example.com',$2,'saved-source','2026-10-01','2026-10-28','google_quota_exceeded') returning id`,[site,kind])).rows[0].id
   await db.query(`insert into public.google_report_snapshots(job_id,data) values($1,$2)`,[job,JSON.stringify({kind,lighthouseResult:{audits:{fullAudit:true}},profile:{description:'Complete profile'}})])
   if (kind==='business_profile') await db.query(`insert into public.google_profile_changes(job_id,snapshot_id,field,before_value,after_value)
    select $1,id,'description','"before"'::jsonb,'"after"'::jsonb from public.google_report_snapshots where job_id=$1`,[job])
  }
  async function identity(user,anonymous=false) {
   await db.exec('reset role; set role authenticated')
   await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,is_anonymous:anonymous})])
  }
  async function read(dataset='sources',cursor=null,limit=2,job=null) {
   return (await db.query('select public.website_saved_data($1,$2,$3,$4,$5) as data',['example.com',dataset,job,cursor,limit])).rows[0].data
  }
  await identity(other); await assert.rejects(()=>read(),/Website not found/)
  await identity(owner,true); await assert.rejects(()=>read(),/Website not found/)
  await identity(owner)
  let cursor=null, sources=[]
  do {
   const page=await read('sources',cursor)
   assert.equal(page.connection_status,'connected'); assert.equal(page.business_locations[0].location_id,'locations/1')
   assert.ok(!JSON.stringify(page).includes('SECRET')); assert.ok(!JSON.stringify(page).includes('lease'))
   sources.push(...page.items); cursor=page.next_cursor
   assert.equal(page.has_more,cursor!==null)
  } while(cursor)
  assert.deepEqual(sources.map(x=>x.kind).sort(),kinds.sort())
  assert.ok(sources.every(x=>x.state==='error' && x.last_error==='google_quota_exceeded'))
  let snapshots=[]
  do {const page=await read('snapshots',cursor);snapshots.push(...page.items);cursor=page.next_cursor} while(cursor)
  assert.equal(snapshots.length,9); assert.equal(new Set(snapshots.map(x=>x.id)).size,9)
  assert.ok(snapshots.every(x=>x.data.lighthouseResult.audits.fullAudit && x.data.profile.description==='Complete profile'))
  const source=sources.find(x=>x.kind==='analytics')
  assert.equal((await read('snapshots',null,100,source.id)).items.length,1)
  assert.equal((await read('profile_changes')).items[0].after_value,'after')
  for (const args of [['invalid'],['sources',null,0],['snapshots','bad'],['snapshots','-1'],['sources','bad'],['snapshots',null,2,other]])
   await assert.rejects(()=>read(...args),/Invalid/)
  await assert.rejects(()=>db.query('select * from public.google_report_snapshots'),/permission denied/)
  await db.exec('reset role; set role anon'); await assert.rejects(()=>read(),/permission denied/)
  await db.exec(`reset role; update public.websites set fqdn='renamed.example.com' where id='${site}'`)
  await identity(owner); await assert.rejects(()=>read(),/Website not found/)
  const renamed=(await db.query("select public.website_saved_data('renamed.example.com','snapshots') as data")).rows[0].data
  assert.deepEqual(renamed.items,[])
 } finally {await db.close()}
})
