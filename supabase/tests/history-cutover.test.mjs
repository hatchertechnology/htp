import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('disconnected arbitrary ranges use canonical Google and Bing days without registering jobs', async () => {
  const db = new PGlite()
  const owner='00000000-0000-0000-0000-000000000001', site='00000000-0000-0000-0000-000000000003'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    const dir=new URL('../migrations/',import.meta.url)
    for (const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,dir),'utf8'))
    await db.exec(`insert into auth.users values('${owner}'); insert into public.websites(id,owner_id,fqdn,ga4_property_id) values('${site}','${owner}','example.com','123');
      insert into public.google_connections(owner_id,encrypted_grant,scopes,status) values('${owner}','','{}','disconnected');
      insert into public.bing_connections(owner_id,encrypted_grant,status) values('${owner}','','disconnected');`)
    const gj=(await db.query("insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date) values($1,'example.com','analytics','123','2026-10-01','2026-10-28') returning id",[site])).rows[0].id
    const bj=(await db.query("insert into public.bing_report_jobs(website_id,fqdn) values($1,'example.com') returning id",[site])).rows[0].id
    const daily={dimensionHeaders:[{name:'date'}],metricHeaders:[{name:'sessions'},{name:'activeUsers'}],rows:['02','04'].map((d,i)=>({dimensionValues:[{value:`202610${d}`}],metricValues:[{value:String(i+2)},{value:'9'}]}))}
    await db.query('insert into public.google_report_snapshots(job_id,data) values($1,$2)',[gj,{daily,summary:{metricHeaders:[{name:'activeUsers'}],rows:[{metricValues:[{value:'12'}]}]}}])
    await db.query('insert into public.bing_report_snapshots(job_id,data) values($1,$2)',[bj,{site_url:'https://example.com/',sections:{traffic:{rows:[{Date:'2026-10-02',Clicks:2,Impressions:10},{Date:'2026-10-04',Clicks:3,Impressions:20}],error:null}}}])
    const counts=async()=> (await db.query('select (select count(*)::int from public.google_report_jobs) g,(select count(*)::int from public.bing_report_jobs) b')).rows[0]
    const before=await counts()
    await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})])
    const google=async(start,end,prop='123')=>(await db.query("select public.request_google_report($1,'analytics',$2,$3,$4) r",[site,prop,start,end])).rows[0].r
    const bing=async(start,end)=>(await db.query('select public.read_bing_history($1,$2,$3) r',[site,start,end])).rows[0].r
    const g=await google('2026-10-02','2026-10-05'), b=await bing('2026-10-02','2026-10-05')
    assert.equal(g.sync.connection_status,'disconnected'); assert.equal(b.sync.connection_status,'disconnected')
    assert.deepEqual(g.sync.coverage.missing_dates,['2026-10-03','2026-10-05']); assert.deepEqual(b.sync.coverage.missing_dates,g.sync.coverage.missing_dates)
    assert.equal(g.data.daily.rows.length,2); assert.equal(b.data.sections.traffic.rows.length,2)
    assert.equal(g.data.summary.metricHeaders.some(x=>x.name==='activeUsers'),false,'unique users require exact snapshot')
    await google('2026-10-03','2026-10-04'); await bing('2026-10-03','2026-10-04')
    await db.exec('reset role'); assert.deepEqual(await counts(),before)
    await db.query("update public.websites set ga4_property_id='456' where id=$1",[site]); await db.exec('set role authenticated')
    assert.equal((await google('2026-10-02','2026-10-05','456')).sync.coverage.state,'unavailable')
    await assert.rejects(()=>google('2026-10-02','2026-10-05','123'),/Save the website/)
  } finally { await db.close() }
})

test('scheduled recovery is bounded and does not starve another site', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    const dir=new URL('../migrations/',import.meta.url)
    for (const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,dir),'utf8'))
    await db.exec(`insert into auth.users values('00000000-0000-0000-0000-000000000001');
      insert into public.websites(id,owner_id,fqdn,ga4_property_id) values
      ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','one.example','123'),
      ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','two.example','456');
      insert into public.google_connections(owner_id,encrypted_grant,scopes,status) values('00000000-0000-0000-0000-000000000001','x',array['https://www.googleapis.com/auth/analytics.readonly'],'connected');
      insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,next_run_at) values
      ('00000000-0000-0000-0000-000000000003','one.example','analytics','123','2020-01-01','2020-01-28',now()-interval '100 days');`)
    await db.exec('set role service_role')
    const claim=async()=>(await db.query('select public.claim_google_report() j')).rows[0].j
    const first=await claim(), second=await claim()
    assert.notEqual(first.website_id,second.website_id,'sites receive turns before either monopolizes collection')
    assert.notEqual(first.start_date?.slice(0,10),'2020-01-01','legacy range is not claimed')
    const jobs=(await db.query("select website_id,kind,count(*)::int n,max(end_date-start_date)::int span from public.google_report_jobs where collection_class='recovery' and refresh_until>now() group by website_id,kind")).rows
    assert.ok(jobs.length>0); assert.ok(jobs.every(j=>j.n===1 && j.span<=27),'one bounded recovery range per source')
  } finally { await db.close() }
})
