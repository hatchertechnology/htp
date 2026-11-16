import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('keyed requests reconcile, conflict and withdraw without changing legacy work', async () => {
  const db = new PGlite()
  const owner='00000000-0000-0000-0000-000000000001', site='00000000-0000-0000-0000-000000000003'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    const dir=new URL('../migrations/',import.meta.url)
    for (const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(f,dir),'utf8'))
    await db.exec(`insert into auth.users values('${owner}'); insert into public.websites(id,owner_id,fqdn,ga4_property_id) values('${site}','${owner}','example.com','123');
      insert into public.google_connections(owner_id,encrypted_grant,scopes,status) values('${owner}','','{}','disconnected'); set role authenticated;`)
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})])
    const create=async(k,end='2025-01-28')=>(await db.query("select public.register_provider_report_request($1,$2,'analytics','123','2025-01-01',$3) r",[site,k,end])).rows[0].r
    const get=async(k)=>(await db.query('select public.get_provider_report_request($1,$2) r',[site,k])).rows[0].r
    const cancel=async(k)=>(await db.query('select public.cancel_provider_report_request($1,$2) r',[site,k])).rows[0].r
    assert.equal((await get('bad key')).code,'INVALID_ARGUMENT'); assert.equal((await cancel('bad key')).code,'INVALID_ARGUMENT')
    const a=await create('a'); assert.equal(a.collection.status,'accepted')
    assert.deepEqual(await create('a'),a); assert.deepEqual(await get('a'),a)
    assert.equal((await create('a','2025-01-27')).code,'CONFLICT')
    assert.equal((await create('b')).collection.status,'accepted')
    assert.equal((await cancel('a')).collection.status,'withdrawn'); assert.equal((await create('a')).collection.status,'withdrawn')
    await db.exec('reset role')
    let job=(await db.query("select * from public.google_report_jobs where kind='analytics'")).rows[0]
    assert.ok(job.keyed_until); assert.equal(job.explicit_until,null)
    await db.exec('set role authenticated'); await cancel('b'); await db.exec('reset role')
    job=(await db.query("select * from public.google_report_jobs where kind='analytics'")).rows[0]
    assert.equal(job.keyed_until,null)
    await db.exec('set role authenticated')
    await db.query("select public.register_report_collection($1,'analytics','123','2025-01-01','2025-01-28')",[site])
    await create('c'); await cancel('c'); await db.exec('reset role')
    job=(await db.query("select * from public.google_report_jobs where kind='analytics'")).rows[0]
    assert.ok(job.explicit_until); assert.ok(new Date(job.explicit_until)>new Date())
    await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000002',is_anonymous:false})])
    assert.equal((await get('a')).code,'NOT_FOUND'); assert.equal((await cancel('a')).code,'NOT_FOUND')
    await db.exec('reset role')
    await db.query("update public.provider_report_requests set expires_at=now()-interval '1 day' where request_key='b' and website_id=$1",[site])
    await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})])
    assert.equal((await cancel('b')).collection.status,'withdrawn')
    const d=await create('expiry'); await db.exec('reset role')
    await db.query("update public.provider_report_requests set expires_at=now()-interval '1 day' where request_key='expiry' and website_id=$1",[site])
    await db.exec('set role authenticated')
    const expired=await get('expiry'); assert.equal(expired.collection.status,'expired')
    assert.deepEqual(await create('expiry'),expired); assert.deepEqual(await cancel('expiry'),expired)
    assert.notEqual(d.collection.expiresAt, expired.collection.expiresAt)
    // Withdrawal prevents a later claim, while a lease acquired beforehand survives.
    const registerWindow=async(k)=>(await db.query("select public.register_provider_report_request($1,$2,'analytics','123','2024-01-01','2024-01-28') r",[site,k])).rows[0].r
    await registerWindow('race-one'); await cancel('race-one'); await db.exec('reset role')
    await db.exec("update public.google_connections set status='connected', scopes=array['https://www.googleapis.com/auth/analytics.readonly']; update public.google_report_jobs set next_run_at=now()+interval '1 day'; update public.google_report_jobs set next_run_at=now()-interval '1 day' where start_date='2024-01-01'; set role service_role")
    let claim=(await db.query('select public.claim_google_report() j')).rows[0].j
    assert.notEqual(claim?.start_date?.slice(0,10),'2024-01-01')
    await db.exec('reset role; set role authenticated'); await registerWindow('race-two'); await db.exec('reset role; set role service_role')
    claim=(await db.query('select public.claim_google_report() j')).rows[0].j
    assert.equal(claim?.start_date?.slice(0,10),'2024-01-01')
    await db.exec('reset role; set role authenticated'); assert.equal((await cancel('race-two')).collection.status,'withdrawn'); await db.exec('reset role')
    assert.ok((await db.query('select lease from public.google_report_jobs where id=$1',[claim.id])).rows[0].lease)
    await db.query(`insert into public.provider_report_requests(website_id,request_key,fqdn,kind,property_id,start_date,end_date,job_id,expires_at)
      select $1,'cap-'||n,'example.com','bing','',null,null,gen_random_uuid(),now()+interval '1 day' from generate_series(1,100) n`,[site])
    await db.exec('set role authenticated')
    assert.equal((await create('over-cap')).code,'LIMIT_EXCEEDED')
    assert.equal((await get('a')).collection.status,'withdrawn')
    await db.exec('reset role')
    await db.query("update public.provider_report_requests set expires_at=now()-interval '1 day' where website_id=$1",[site])
    await db.query(`insert into public.provider_report_requests(website_id,request_key,fqdn,kind,property_id,job_id,expires_at)
      select $1,'retained-'||n,'example.com','bing','',gen_random_uuid(),now()-interval '1 day'
      from generate_series(1,1000-(select count(*)::int from public.provider_report_requests where website_id=$1)) n`,[site])
    await db.exec('set role authenticated')
    assert.equal((await create('over-retention')).code,'LIMIT_EXCEEDED')
    assert.equal((await create('a')).collection.status,'withdrawn')
  } finally { await db.close() }
})

test('undated and ignored provider inputs normalize at the RPC boundary', async () => {
  const db = new PGlite()
  const owner='00000000-0000-0000-0000-000000000011', site='00000000-0000-0000-0000-000000000013'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    const dir=new URL('../migrations/',import.meta.url)
    for (const f of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(f,dir),'utf8'))
    await db.exec(`insert into auth.users values('${owner}'); insert into public.websites(id,owner_id,fqdn) values('${site}','${owner}','example.com');
      insert into public.website_business_locations(website_id,fqdn,location_id) values('${site}','example.com','locations/10');
      create or replace function public.business_profile_enabled() returns boolean language sql immutable set search_path='' as $$ select true $$; set role authenticated;`)
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})])
    const register=async(key,kind,property,start=null,end=null)=>(await db.query('select public.register_provider_report_request($1,$2,$3,$4,$5,$6) r',[site,key,kind,property,start,end])).rows[0].r
    for (const [kind, property] of [['pagespeed','mobile'],['crux','PHONE'],['business_locations',''],['business_profile','locations/10'],['properties','ignored']]) {
      const first=await register(kind,kind,property)
      assert.equal(first.collection.status,'accepted',kind)
      assert.equal(first.collection.association.startDate,'1970-01-01')
      assert.deepEqual(await register(kind,kind,kind==='properties'?'different':property,null,null),first)
      assert.equal((await register(kind,kind,property,'2025-01-01','2025-01-28')).code,'CONFLICT')
      assert.equal((await register('invalid-'+kind,kind,property,'2024-01-01','2025-01-02')).code,'INVALID_ARGUMENT')
      assert.equal((await register('partial-'+kind,kind,property,null,'2025-01-28')).code,'INVALID_ARGUMENT')
    }
    assert.equal((await register('bad-source','pagespeed','attacker')).code,'INVALID_ARGUMENT')
    assert.equal((await register('dated','analytics','123')).code,'INVALID_ARGUMENT')
    const bing=await register('bing','bing','ignored')
    assert.equal(bing.collection.status,'accepted'); assert.equal(bing.collection.association.propertyId,null)
    assert.deepEqual(await register('bing','bing','other'),bing)
    assert.equal((await register('bing','bing','ignored','2025-01-01','2025-01-28')).code,'CONFLICT')
  } finally { await db.close() }
})
