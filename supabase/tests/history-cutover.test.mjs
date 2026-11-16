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
    // A later no-match discovery must not erase the last selected source.
    await db.query('insert into public.bing_report_snapshots(job_id,data) values($1,$2)',[bj,{site_url:null,sections:{}}])
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
    await db.exec('reset role')
    await db.query('insert into public.bing_report_snapshots(job_id,data) values($1,$2)',[bj,{site_url:'https://example.com/',sections:{traffic:{rows:null,error:'bing_quota_exceeded'}}}])
    await db.exec('set role authenticated')
    const failed=await bing('2026-10-02','2026-10-05')
    assert.equal(failed.data.sections.traffic.error,'bing_quota_exceeded'); assert.equal(failed.data.sections.traffic.rows.length,2)
    await db.exec('reset role')
    await db.query('insert into public.bing_report_snapshots(job_id,data) values($1,$2)',[bj,{site_url:'https://new.example.com/',sections:{traffic:{rows:[{Date:'2026-10-02',Clicks:99,Impressions:100}],error:null}}}])
    await db.exec('set role authenticated')
    const rebound=await bing('2026-10-02','2026-10-05')
    assert.equal(rebound.data.site_url,'https://new.example.com/'); assert.equal(rebound.data.sections.traffic.rows.length,1)
    assert.equal(rebound.data.sections.traffic.rows[0].Clicks,99,'never mix old Bing property')
    await google('2026-10-03','2026-10-04'); await bing('2026-10-03','2026-10-04')
    await db.exec('reset role'); assert.deepEqual(await counts(),before)
    await db.exec('set role authenticated')
    const register=async()=> (await db.query("select public.register_report_collection($1,'analytics','123','2026-10-02','2026-10-05') r",[site])).rows[0].r
    for (const property of ['sc-domain:other.example','https://other.example/','https://example.com.evil.test/','https://example.com/?q=1','https://example.com/evil#x','https://example.com/\\evil']) {
      await assert.rejects(() => db.query("select public.register_report_collection($1,'search',$2,'2026-10-02','2026-10-05')",[site,property]),/Invalid Search property/)
    }
    assert.equal((await db.query("select public.register_report_collection($1,'search','https://example.com/','2026-10-02','2026-10-05') r",[site])).rows[0].r.collectionRegistered,true)
    assert.equal((await register()).collectionRegistered,true); assert.equal((await register()).collectionRegistered,true)
    assert.equal((await db.query("select public.register_report_collection($1,'bing','','1970-01-01','1970-01-01') r",[site])).rows[0].r.collectionRegistered,true)
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-0000-0000-000000000002',is_anonymous:false})])
    await assert.rejects(register,/Website not found/)
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:true})])
    await assert.rejects(register,/Website not found/)
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,is_anonymous:false})])
    await db.exec('reset role')
    assert.deepEqual(await counts(),{g:before.g+2,b:before.b},'explicit requests are idempotent and separate from reads')
    assert.equal((await db.query("select collection_class from public.google_report_jobs where kind='analytics' and start_date='2026-10-02' and end_date='2026-10-05'")).rows[0].collection_class,'explicit')
    await db.exec("update public.google_connections set status='connected',scopes=array['https://www.googleapis.com/auth/analytics.readonly']; set role service_role")
    for (let i=0;i<12;i++) { const job=(await db.query('select public.claim_google_report() j')).rows[0].j; if (!job) break; if (job.collection_class==='explicit') { assert.equal(job.start_date.slice(0,10),'2026-10-02'); break } await db.query('select public.complete_google_report($1,$2,$3,$4,null)',[job.id,job.lease,job.generation,{}]) }
    assert.equal((await db.query("select count(*)::int n from public.google_report_jobs where collection_class='explicit' and lease is not null")).rows[0].n,1,'scheduler serves explicit work')
    await db.exec('reset role')
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
    await db.exec('reset role')
    await db.exec(`update public.google_connections set scopes=array['https://www.googleapis.com/auth/analytics.readonly','https://www.googleapis.com/auth/webmasters.readonly'];
      insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date) values
      ('00000000-0000-0000-0000-000000000003','one.example','properties','','1970-01-01','1970-01-01');
      insert into public.google_report_snapshots(job_id,data) select id,'{"properties":[{"siteUrl":"sc-domain:one.example"},{"siteUrl":"https://one.example/"}]}'::jsonb from public.google_report_jobs where kind='properties';`)
    await db.exec('set role service_role')
    const first=await claim(), second=await claim()
    const search=(await db.query("select property_id from public.google_report_jobs where kind='search' and start_date=current_date-28 and end_date=current_date-1 order by property_id")).rows
    assert.deepEqual(search.map(x=>x.property_id),['https://one.example/','sc-domain:one.example'], 'each selectable property receives current scheduled work')
    assert.notEqual(first.website_id,second.website_id,'sites receive turns before either monopolizes collection')
    assert.notEqual(first.start_date?.slice(0,10),'2020-01-01','legacy range is not claimed')
    const jobs=(await db.query("select website_id,kind,property_id,count(*)::int n,max(end_date-start_date)::int span from public.google_report_jobs where collection_class='recovery' and refresh_until>now() group by website_id,kind,property_id")).rows
    assert.ok(jobs.length>0); assert.ok(jobs.every(j=>j.n===1 && j.span<=27),'one bounded recovery range per source')
    // Release the first leases and drain repeatedly: recovery should progress
    // across both sites even when older current work remains due.
    await db.query("update public.google_report_jobs set lease=null,leased_until=null where id in ($1,$2)",[first.id,second.id])
    const served=new Set(), recoveries=new Set()
    for (let i=0;i<30;i++) {
      await db.exec("update public.google_report_jobs set next_run_at=now()-interval '1 minute' where collection_class='current' and leased_until is null")
      const j=await claim(); if (!j) break
      served.add(j.website_id)
      if (j.collection_class==='recovery') recoveries.add(j.website_id)
      assert.equal((await db.query('select public.complete_google_report($1,$2,$3,$4,null) ok',[j.id,j.lease,j.generation,{}])).rows[0].ok,true)
    }
    assert.equal(served.size,2); assert.equal(recoveries.size,2,'recovery makes progress on both sites under sustained load')
    assert.equal((await db.query("select count(*)::int n from public.google_report_jobs where collection_class='legacy' and lease is not null")).rows[0].n,0)
    // Simulate a rolling date boundary by leaving prior windows expired and
    // verifying current date jobs are recreated from retained discovery.
    await db.exec("update public.google_report_jobs set start_date=start_date-1,end_date=end_date-1,refresh_until=now()-interval '1 day' where kind='search' and collection_class='current'")
    await db.exec(`insert into public.google_report_snapshots(job_id,data) select id,'{"properties":[{"siteUrl":"sc-domain:one.example"},{"siteUrl":"https://one.example/"}]}'::jsonb from public.google_report_jobs where kind='properties' and fqdn='one.example'`)
    await claim()
    const rolled=(await db.query("select count(distinct property_id)::int n from public.google_report_jobs where kind='search' and start_date=current_date-28 and end_date=current_date-1")).rows[0].n
    assert.equal(rolled,2,'both discovered properties roll forward')
  } finally { await db.close() }
})
