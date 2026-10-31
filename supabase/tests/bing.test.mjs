import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('Bing ownership, automatic collection, leases, retention, pagination and credential fencing', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    const migrations = new URL('../migrations/', import.meta.url)
    for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, migrations), 'utf8'))
    const owner = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002', site = '00000000-0000-0000-0000-000000000003'
    await db.exec(`insert into auth.users values('${owner}'),('${other}'); insert into public.websites(id,owner_id,fqdn) values('${site}','${owner}','example.com');
      insert into public.bing_connections(owner_id,encrypted_grant) values('${owner}','private-grant');`)
    const identity = async (user, anonymous = false) => {
      await db.exec('reset role; set role authenticated')
      await db.query(`select set_config('request.jwt.claims',$1,false)`, [JSON.stringify({ sub: user, is_anonymous: anonymous })])
    }
    const request = () => db.query('select public.request_bing_report($1) as report', [site])
    await identity(other); await assert.rejects(request, /Website not found/)
    await identity(owner, true); await assert.rejects(request, /Website not found/)
    await identity(owner)
    for (const table of ['bing_connections', 'bing_report_jobs', 'bing_report_snapshots']) await assert.rejects(() => db.query(`select * from public.${table}`), /permission denied/)
    await assert.rejects(() => db.query('select public.claim_bing_report()'), /permission denied/)
    await assert.rejects(() => db.query(`select public.google_website_saved_data('example.com','sources')`), /permission denied/)
    await db.exec('reset role; set role service_role')
    const claim = async () => (await db.query('select public.claim_bing_report() as job')).rows[0].job
    const complete = async (j, data, error = null) => (await db.query('select public.complete_bing_report($1,$2,$3,$4,$5) as saved', [j.id,j.lease,j.generation,data,error])).rows[0].saved
    const first = await claim()
    assert.equal(first.fqdn, 'example.com', 'seeds jobs without a dashboard visit')
    assert.equal(await claim(), null, 'leased work cannot be claimed twice')
    const report = { sites: [{ Url: 'https://example.com', IsVerified: true }], site_url: 'https://example.com', sections: { traffic: { rows: [{ Clicks: 2, Impressions: 10 }], error: null } } }
    assert.equal(await complete(first, report), true)
    assert.equal(await complete(first, report), false)
    await identity(owner)
    const saved = (await request()).rows[0].report
    assert.equal(saved.sync.cadence, 'daily'); assert.equal(saved.sync.state, 'ready'); assert.deepEqual(saved.data, report)
    let evidenceHost = 'example.com'
    const evidence = async (dataset, cursor = null, limit = 1) => (await db.query(`select public.website_saved_data($1,$2,null,$3,$4) as result`, [evidenceHost,dataset,cursor,limit])).rows[0].result
    assert.equal((await evidence('bing_sources')).items[0].kind, 'bing')
    assert(!JSON.stringify(await evidence('bing_sources')).includes('private-grant'))
    assert.deepEqual((await evidence('sources')).additional_datasets, ['bing_sources','bing_snapshots'])
    await assert.rejects(() => evidence('bing_snapshots','bad'), /Invalid cursor/)
    await db.exec('reset role')
    await db.query(`update public.bing_report_jobs set next_run_at=now()-interval '1 day' where id=$1`, [first.id])
    await db.exec('set role service_role')
    const fail = await claim()
    assert.equal(await complete(fail, null, 'bing_quota_exceeded'), true)
    await identity(owner)
    const failed = (await request()).rows[0].report
    assert.equal(failed.sync.state, 'error'); assert.deepEqual(failed.data, report)
    await db.exec('reset role')
    await db.query(`update public.bing_report_jobs set next_run_at=now()-interval '1 day' where id=$1`, [first.id])
    await db.exec('set role service_role')
    const expired = await claim()
    await db.query(`update public.bing_report_jobs set leased_until=now()-interval '1 minute' where id=$1`, [first.id])
    const reclaimed = await claim()
    assert.notEqual(expired.lease, reclaimed.lease)
    assert.equal(await complete(expired, report), false)
    assert.equal(await complete(reclaimed, report), true)
    await identity(owner)
    const page1 = await evidence('bing_snapshots'); assert.equal(page1.has_more, true)
    const page2 = await evidence('bing_snapshots',page1.next_cursor); assert.equal(page2.has_more, false)
    assert.notEqual(page1.items[0].id, page2.items[0].id)
    await identity(other); await assert.rejects(() => evidence('bing_snapshots'), /Website not found/)
    await db.exec('reset role')
    await db.query(`update public.bing_report_jobs set next_run_at=now()-interval '1 day' where id=$1`, [first.id])
    await db.exec('set role service_role')
    const inflight = await claim()
    await db.query(`update public.bing_connections set generation=gen_random_uuid(),status='disconnected',encrypted_grant='' where owner_id=$1`,[owner])
    assert.equal(await complete(inflight, report), false)
    assert.equal(await claim(), null)
    assert.equal((await db.query('select public.rotate_bing_grant($1,$2,$3) as rotated',[owner,inflight.generation,'old-refresh'])).rows[0].rotated,false)
    await identity(owner); assert.deepEqual((await request()).rows[0].report.data, report)
    await db.exec('reset role')
    await db.query(`update public.websites set fqdn='new.example.com' where id=$1`,[site])
    evidenceHost = 'new.example.com'
    await identity(owner); assert.equal((await request()).rows[0].report.data,null)
    assert.equal((await evidence('bing_snapshots')).items.length,0)
    await db.exec('reset role')
    await db.query(`update public.bing_connections set generation=gen_random_uuid(),status='connected',encrypted_grant='new' where owner_id=$1`,[owner])
    await db.exec('set role service_role')
    const fresh = await claim(); assert.equal(fresh.fqdn,'new.example.com')
    assert.equal(await complete(fresh,null,'bing_authorization_required'),true)
    assert.equal(await claim(),null)
    await db.exec('reset role')
    await db.query(`update public.bing_report_jobs set next_run_at=now()+interval '1 day'`)
    await db.query(`update public.bing_connections set generation=gen_random_uuid(),status='connected' where owner_id=$1`,[owner])
    await db.exec('set role service_role')
    const reconnected = await claim()
    assert.equal(reconnected.fqdn,'new.example.com','reconnection resets the daily schedule immediately')
    assert.equal(await complete(fresh,report),false,'prior generation cannot commit after reconnection')
    assert.equal(await complete(reconnected,report),true)
    await db.exec('reset role')
    await db.query('delete from public.websites where id=$1',[site])
    assert.equal((await db.query('select count(*)::int as n from public.bing_report_snapshots')).rows[0].n,0)
  } finally { await db.close() }
})
