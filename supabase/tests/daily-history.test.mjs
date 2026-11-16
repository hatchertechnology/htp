import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const owner = '00000000-0000-0000-0000-000000000001'
const other = '00000000-0000-0000-0000-000000000002'
const site = '00000000-0000-0000-0000-000000000003'
const migration = '20261116210148_canonical_daily_history.sql'
const ga = (day, value) => ({ dimensionValues: [{ value: day }], metricValues: [{ value: String(value) }] })
const report = rows => ({ daily: { dimensionHeaders: [{ name: 'date' }], metricHeaders: [{ name: 'activeUsers' }], rows }, summary: { uniqueUsers: 999 } })

test('canonical history preserves revisions and provenance, backfills safely and reads disconnected arbitrary ranges without jobs', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    const dir = new URL('../migrations/', import.meta.url)
    for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql') && n < migration).sort()) await db.exec(await readFile(new URL(name, dir), 'utf8'))
    await db.exec(`insert into auth.users values('${owner}'),('${other}');
      insert into public.websites(id,owner_id,fqdn,ga4_property_id) values('${site}','${owner}','example.com','123');
      insert into public.google_connections(owner_id,encrypted_grant,scopes,status) values('${owner}','encrypted','{}','disconnected');`)
    async function job(kind, property, start = '2026-10-01', end = '2026-10-28', fqdn = 'example.com') {
      return (await db.query(`insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date)
        values($1,$2,$3,$4,$5,$6) returning id`, [site, fqdn, kind, property, start, end])).rows[0].id
    }
    async function snapshot(id, data, fetched = '2026-11-01T00:00:00Z') {
      return (await db.query('insert into public.google_report_snapshots(job_id,data,fetched_at) values($1,$2,$3) returning id', [id, JSON.stringify(data), fetched])).rows[0].id
    }
    const oldJob = await job('analytics', '123')
    const oldSnapshot = await snapshot(oldJob, report([ga('20261002', 10), ga('20261003', 20)]))
    const overlap = await job('analytics', '123', '2026-10-02', '2026-10-29')
    const newerSnapshot = await snapshot(overlap, report([ga('20261003', 30), ga('20261004', 40)]), '2026-11-02T00:00:00Z')
    await db.exec(await readFile(new URL(migration, dir), 'utf8'))
    const backfill = async (provider = 'google', cursor = 0, limit = 100) => (await db.query('select public.backfill_daily_history($1,$2,$3) as r', [provider,cursor,limit])).rows[0].r
    await db.exec('set role service_role')
    assert.deepEqual(await backfill('google', 0, 1), { next_cursor: oldSnapshot, processed: 1, changed: 2 })
    assert.equal((await backfill('google', oldSnapshot, 1)).next_cursor, newerSnapshot)
    assert.equal((await backfill()).changed, 0, 'replaying older overlapping observations cannot overwrite newer ones')
    await assert.rejects(() => backfill('google', 0, 501), /Invalid history backfill/)
    await assert.rejects(() => backfill(null), /Invalid history backfill/)
    const countJobs = (await db.query('select count(*)::int as n from public.google_report_jobs')).rows[0].n
    async function identity(id = owner, anonymous = false) {
      await db.exec('reset role; set role authenticated')
      await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({sub:id,is_anonymous:anonymous})])
    }
    const read = async (source = 'analytics', property = '123', start = '2026-10-02', end = '2026-10-05') =>
      (await db.query('select public.read_daily_history($1,$2,$3,$4,$5) as r', [site,source,property,start,end])).rows[0].r
    await identity()
    const data = await read()
    assert.equal(data.coverage.state, 'partial')
    assert.deepEqual(data.coverage.missing_dates, ['2026-10-05'])
    assert.deepEqual(data.daily.map(d => d.row.metricValues[0].value), ['10','30','40'])
    assert.equal(data.daily[1].snapshot_id, newerSnapshot)
    assert.equal(data.summary, undefined, 'unique users are never summed into an arbitrary-range summary')
    assert.equal((await read('analytics','123','2026-10-02','2026-10-04')).coverage.state, 'complete')
    assert.equal((await read('analytics','123','2026-09-01','2026-09-02')).coverage.state, 'unavailable')
    await assert.rejects(() => read('analytics', '456'), /Save the website/)
    await assert.rejects(() => read('pagespeed', 'mobile'), /Invalid history range/)
    await assert.rejects(() => read('analytics','123','2025-01-01','2026-10-01'), /Invalid history range/)
    await assert.rejects(() => backfill(), /permission denied/)
    await assert.rejects(() => db.query('select * from public.provider_daily_history'), /permission denied/)
    await identity(other); await assert.rejects(read, /Website not found/)
    await identity(owner,true); await assert.rejects(read, /Website not found/)
    await db.exec('reset role; set role anon'); await assert.rejects(read, /permission denied/)
    await db.exec('reset role')
    assert.equal((await db.query('select count(*)::int as n from public.google_report_jobs')).rows[0].n,countJobs)
    // Live writes race safely with backfill; equal timestamps use snapshot id.
    const tie = await snapshot(overlap, report([ga('20261003', 35)]), '2026-11-02T00:00:00Z')
    await snapshot(oldJob, report([ga('20261003', 1)]), '2026-10-31T00:00:00Z')
    await backfill()
    await identity(); assert.equal((await read()).daily[1].snapshot_id,tie)
    await db.exec('reset role')
    // Bad legacy dates, absent metric values and out-of-range rows do not claim coverage.
    await snapshot(oldJob, report([ga('20260230', 1),ga('20261102', 1), {dimensionValues:[{value:'20261005'}]}]))
    await snapshot(oldJob, {daily:{rows:{invalid:true}}})
    const conversionJob = await job('conversions','123')
    await snapshot(conversionJob,report([ga('20261003',5)]))
    const searchJob = await job('search','sc-domain:example.com')
    await snapshot(searchJob,{daily:{rows:[{keys:['2026-10-03'],clicks:2,impressions:20,ctr:0.1,position:3}]}})
    const health = await job('crux','PHONE','1970-01-01','1970-01-01')
    await snapshot(health,{record:{collectionPeriod:{firstDate:{year:2026,month:10,day:1}}}})
    const previousHost = await job('analytics','123','2026-10-01','2026-10-28','old.example.com')
    await snapshot(previousHost,report([ga('20261005',200)]))
    await identity()
    assert.deepEqual((await read()).coverage.missing_dates,['2026-10-05'])
    assert.equal((await read('conversions','123')).daily[0].row.metricValues[0].value,'5')
    assert.equal((await read('search','sc-domain:example.com')).daily[0].row.position,3)
    await db.exec('reset role')
    const bingJob = (await db.query('insert into public.bing_report_jobs(website_id,fqdn) values($1,$2) returning id',[site,'example.com'])).rows[0].id
    const bing = async (rows, error = null) => db.query('insert into public.bing_report_snapshots(job_id,data) values($1,$2)',[bingJob,JSON.stringify({site_url:'https://example.com/',sections:{traffic:{rows,error}}})])
    await bing([{Date:'/Date(1316156400000-0700)/',Clicks:2,Impressions:20}])
    await bing([{Date:'2026-10-03',Clicks:3,Impressions:30}])
    await bing([{Date:'2026-10-04',Clicks:0,Impressions:0}], 'bing_quota_exceeded')
    await bing([{Date:'2026-10-04',Clicks:0,Impressions:0}])
    await backfill('bing')
    await identity()
    const bingData = await read('bing_traffic','https://example.com/')
    assert.deepEqual(bingData.daily.map(d=>d.date),['2026-10-03','2026-10-04'])
    assert.deepEqual(bingData.coverage.missing_dates,['2026-10-02','2026-10-05'])
    assert.equal((await read('bing_traffic','https://example.com/','2011-09-16','2011-09-16')).coverage.state,'complete')
    await db.exec('reset role')
    assert.equal((await db.query('select count(*)::int as n from public.bing_report_jobs')).rows[0].n,1)
    assert.equal((await db.query("select count(*)::int as n from public.provider_daily_history where source='crux'")).rows[0].n,0)
    // Source rebinding isolates old data but retains it for recovery.
    await db.query("update public.websites set ga4_property_id='456' where id=$1",[site])
    await identity(); assert.equal((await read('analytics','456')).daily.length,0)
    await db.exec('reset role')
    assert.ok((await db.query('select count(*)::int as n from public.provider_daily_history')).rows[0].n > 0)
    assert.ok((await db.query('select count(*)::int as n from public.google_report_snapshots')).rows[0].n > 0)
  } finally { await db.close() }
})
