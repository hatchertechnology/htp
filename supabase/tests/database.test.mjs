import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('Google sync migrations enforce ownership, leases, history, retries and disconnects', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;
    `)
    const migrations = new URL('../migrations/', import.meta.url)
    for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, migrations), 'utf8'))
    const owner = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002'
    const site = '00000000-0000-0000-0000-000000000003'
    await db.exec(`insert into auth.users values('${owner}'),('${other}');
      insert into public.websites(id,owner_id,fqdn,ga4_property_id) values('${site}','${owner}','example.com','123');
      insert into public.google_connections(owner_id,encrypted_grant,scopes) values('${owner}','encrypted',array['https://www.googleapis.com/auth/analytics.readonly','https://www.googleapis.com/auth/webmasters.readonly']);`)
    const identity = async (user, anonymous = false) => {
      await db.exec('reset role; set role authenticated')
      await db.query(`select set_config('request.jwt.claims',$1,false)`, [JSON.stringify({ sub: user, is_anonymous: anonymous })])
    }
    const request = () => db.query(`select public.request_google_report($1,'analytics','123','2026-10-01','2026-10-27') as result`, [site])
    await identity(other)
    await assert.rejects(request, /Website not found/)
    await identity(owner, true)
    await assert.rejects(request, /Website not found/)
    await identity(owner)
    await assert.rejects(() => db.query('select * from public.google_connections'), /permission denied/)
    await assert.rejects(() => db.query('select public.claim_google_report()'), /permission denied/)
    await assert.rejects(() => db.query(`select public.request_google_report($1,'analytics','456','2026-10-01','2026-10-27')`, [site]), /Save the website/)
    const pending = (await request()).rows[0].result
    assert.equal(pending.sync.state, 'pending')
    await request()
    await db.exec('reset role')
    assert.equal((await db.query(`select count(*)::integer as n from public.google_report_jobs`)).rows[0].n, 1)
    await db.exec('set role service_role')
    const claim = async () => (await db.query('select public.claim_google_report() as job')).rows[0].job
    const first = await claim()
    assert.equal(first.property_id, '123')
    assert.equal(first.fqdn, 'example.com')
    const another = await claim()
    assert.notEqual(another.id, first.id, 'a leased job must not be claimed twice')
    const complete = async (job, data, error = null) => (await db.query('select public.complete_google_report($1,$2,$3,$4,$5) as saved', [job.id, job.lease, job.generation, data, error])).rows[0].saved
    const report = { summary: { metricHeaders: [{ name: 'activeUsers' }], rows: [{ metricValues: [{ value: '8' }] }] } }
    assert.equal(await complete(first, report), true)
    assert.equal(await complete(first, report), false, 'a lease can commit only once')
    await identity(owner)
    const ready = (await request()).rows[0].result
    assert.equal(ready.sync.state, 'ready')
    assert.equal(ready.data.summary.rows[0].metricValues[0].value, '8')
    await db.exec('reset role')
    await db.query(`update public.google_report_jobs set next_run_at=now()-interval '1 day' where id=$1`, [first.id])
    await db.exec('set role service_role')
    const retry = await claim()
    assert.equal(retry.id, first.id)
    assert.notEqual(retry.lease, first.lease)
    assert.equal(await complete(first, report), false, 'an old worker cannot overwrite a new lease')
    assert.equal(await complete(retry, null, 'google_quota_exceeded'), true)
    await identity(owner)
    const failed = (await request()).rows[0].result
    assert.equal(failed.sync.state, 'error')
    assert.deepEqual(failed.data, ready.data, 'failed refresh preserves the successful snapshot')
    await db.exec('reset role')
    await db.query(`update public.google_report_jobs set next_run_at=now()-interval '1 day' where id=$1`, [first.id])
    await db.exec('set role service_role')
    const recovered = await claim()
    assert.equal(await complete(recovered, report), true)
    assert.equal((await db.query(`select count(*)::integer as n from public.google_report_snapshots where job_id=$1`, [first.id])).rows[0].n, 2, 'successful syncs append history')
    await db.exec("update public.google_report_jobs set lease=null,leased_until=null,next_run_at=now()-interval '1 day' where kind='properties'")
    const discovered = await claim()
    assert.equal(discovered.kind, 'properties')
    assert.equal(await complete(discovered, { properties: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] }), true)
    await db.exec("update public.google_report_jobs set next_run_at=now()-interval '1 day' where kind='search'")
    const searchJob = await claim()
    assert.equal(searchJob.kind, 'search', 'property discovery seeds default collection without a browser')
    assert.equal(searchJob.property_id, 'sc-domain:example.com')
    await db.query(`update public.google_report_jobs set leased_until=now()-interval '1 minute' where id=$1`, [searchJob.id])
    const reclaimed = await claim()
    assert.equal(reclaimed.id, searchJob.id, 'crashed work becomes eligible after lease expiry')
    assert.notEqual(reclaimed.lease, searchJob.lease)
    assert.equal(await complete(searchJob, { summary: {} }), false)
    assert.equal(await complete(reclaimed, { summary: {} }), true)
    await db.exec('reset role')
    await db.query(`update public.websites set fqdn='renamed.example.com' where id=$1`, [site])
    await identity(owner)
    assert.equal((await request()).rows[0].result.sync.state, 'pending', 'renaming isolates old hostname data')
    await db.exec('reset role')
    await db.query(`update public.websites set fqdn='example.com' where id=$1`, [site])
    await db.exec('set role service_role')
    await db.query(`update public.google_report_jobs set next_run_at=now()-interval '1 day' where id=$1`, [first.id])
    const inFlight = await claim()
    await db.query(`update public.google_connections set status='disconnected',generation=gen_random_uuid(),encrypted_grant='',scopes='{}' where owner_id=$1`, [owner])
    assert.equal(await complete(inFlight, report), false, 'disconnect fences an in-flight worker')
    assert.equal(await claim(), null, 'disconnected accounts stop background collection')
    await identity(owner)
    assert.deepEqual((await request()).rows[0].result.data, ready.data, 'saved data remains readable after disconnect')
    await db.exec('reset role')
    await db.query(`update public.google_connections set status='connected',scopes=array['https://www.googleapis.com/auth/analytics.readonly'] where owner_id=$1`, [owner])
    await db.query(`update public.google_report_jobs set leased_until=null,next_run_at=now()-interval '1 day' where id=$1`, [first.id])
    await db.exec('set role service_role')
    const expired = await claim()
    assert.equal(await complete(expired, null, 'google_authorization_required'), true)
    assert.equal(await claim(), null)
    assert.equal((await db.query('select status from public.google_connections')).rows[0].status, 'reauthorization_required')
    await db.exec('reset role')
    await db.query(`delete from public.websites where id=$1`, [site])
    assert.equal((await db.query('select count(*)::integer as n from public.google_report_snapshots')).rows[0].n, 0)
  } finally { await db.close() }
})
