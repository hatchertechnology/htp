import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('insight collection preserves profile diffs, ownership, bindings, observation history and fencing', async () => {
  const db = new PGlite()
  const owner = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002', site = '00000000-0000-0000-0000-000000000003'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth,public to authenticated,anon,service_role;`)
    const migrations = new URL('../migrations/', import.meta.url)
    for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, migrations), 'utf8'))
    await db.exec(`insert into auth.users values('${owner}'),('${other}');
      insert into public.websites(id,owner_id,fqdn,ga4_property_id) values('${site}','${owner}','example.com','123');
      insert into public.google_connections(owner_id,encrypted_grant,scopes) values('${owner}','encrypted',array['https://www.googleapis.com/auth/analytics.readonly','https://www.googleapis.com/auth/business.manage']);`)
    assert.equal((await db.query('select public.business_profile_enabled() as enabled')).rows[0].enabled, false)
    await db.exec("set role service_role")
    await db.query('select public.claim_google_report()')
    await db.exec('reset role')
    assert.equal((await db.query("select count(*)::int as n from public.google_report_jobs where kind like 'business_%'")).rows[0].n, 0, 'disabled discovery does not seed jobs')
    await db.exec('set role authenticated')
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner, is_anonymous: false })])
    await assert.rejects(() => db.query("select public.request_google_report($1,'business_locations','','2026-10-01','2026-10-28')", [site]), /temporarily disabled/)
    await assert.rejects(() => db.query("select public.set_business_location($1,'locations\/10',true)", [site]), /temporarily disabled/)
    await db.exec("reset role; create or replace function public.business_profile_enabled() returns boolean language sql immutable set search_path = '' as $$ select true $$")
    async function identity(user, anonymous = false) { await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, is_anonymous: anonymous })]) }
    async function report(kind, property, start = '2026-10-01', end = '2026-10-28') { return (await db.query('select public.request_google_report($1,$2,$3,$4,$5) as data', [site, kind, property, start, end])).rows[0].data }
    async function history(kind, property, before = null) { return (await db.query("select public.google_insight_history($1,$2,$3,current_date-1,current_date+1,$4) as data", [site, kind, property, before])).rows[0].data }
    async function bind(linked, location = 'locations/10') { return db.query('select public.set_business_location($1,$2,$3)', [site, location, linked]) }
    async function claim(kind, property = null) {
      await db.exec('reset role');
      await db.exec("update public.google_report_jobs set lease=null,leased_until=null,next_run_at=now()+interval '2 days'");
      await db.query("update public.google_report_jobs set next_run_at=now()-interval '1 day' where kind=$1 and ($2::text is null or property_id=$2)", [kind, property]);
      await db.exec('set role service_role');
      return (await db.query('select public.claim_google_report() as data')).rows[0].data
    }
    async function complete(job, data, error = null) { return (await db.query('select public.complete_google_report($1,$2,$3,$4,$5) as saved', [job.id, job.lease, job.generation, data, error])).rows[0].saved }
    await identity(other); await assert.rejects(() => report('crux', 'PHONE'), /Website not found/); await assert.rejects(() => history('crux', 'PHONE'), /Website not found/); await assert.rejects(() => bind(true), /Website not found/)
    await identity(owner, true); await assert.rejects(() => bind(true), /Website not found/)
    await identity(owner)
    await assert.rejects(() => db.query('select * from public.google_profile_changes'), /permission denied/)
    await assert.rejects(() => db.query('select * from public.website_business_locations'), /permission denied/)
    await assert.rejects(() => bind(true), /Choose a discovered location/)
    await assert.rejects(() => report('pagespeed', 'attacker-url'), /Invalid source/)
    await assert.rejects(() => report('conversions', '456'), /Save the website/)
    await assert.rejects(() => report('business_profile', 'locations/10'), /Link an authorized/)
    await report('business_locations', '')
    await db.exec('reset role; set role service_role'); await db.query('select public.claim_google_report()')
    const discovered = await claim('business_locations')
    assert.equal(await complete(discovered, { locations: [{ name: 'locations/10', title: 'Store' }] }), true)
    await identity(owner); await assert.rejects(() => bind(true, 'locations/99'), /Choose a discovered location/); await bind(true)
    await report('business_profile', 'locations/10'); await report('business_performance', 'locations/10')
    let job = await claim('business_profile')
    assert.equal(await complete(job, { location: { title: 'Old name', websiteUri: 'https://example.com', regularHours: { periods: [] } } }), true)
    assert.equal(await complete(job, { location: { title: 'Bad duplicate' } }), false)
    job = await claim('business_profile')
    await complete(job, { location: { title: 'Old name', websiteUri: 'https://example.com', regularHours: { periods: [] } } })
    assert.equal((await db.query('select count(*)::int as n from public.google_profile_changes')).rows[0].n, 1, 'identical observations do not create edits')
    job = await claim('business_profile')
    await complete(job, { location: { title: 'New name', regularHours: { periods: [] }, phoneNumbers: { primaryPhone: '555' } } })
    await identity(owner)
    const result = await history('business_profile', 'locations/10')
    assert.equal(result.snapshots.length, 3)
    assert.equal(result.changes.length, 4, 'baseline, edited name, removed website, and added phone')
    const name = result.changes.find(c => c.field === 'title')
    assert.equal(name.before_value, 'Old name'); assert.equal(name.after_value, 'New name'); assert.ok(name.previous_snapshot_id); assert.ok(name.previous_observed_at)
    const website = result.changes.find(c => c.field === 'websiteUri'); assert.equal(website.after_value, null)
    assert.equal((await history('business_profile', 'locations/10', result.snapshots[0].id)).snapshots.length, 2)
    assert.equal((await history('business_profile', 'locations/10')).bindings[0], 'locations/10')
    await db.exec("reset role; create or replace function public.business_profile_enabled() returns boolean language sql immutable set search_path = '' as $$ select false $$")
    assert.equal(await claim('business_profile'), null, 'existing Business Profile jobs cannot be claimed while paused')
    await identity(owner)
    assert.equal((await history('business_profile', 'locations/10')).snapshots.length, 3, 'pause preserves readable snapshots')
    assert.equal((await history('business_profile', 'locations/10')).changes.length, 4, 'pause preserves field history')
    await db.exec("reset role; create or replace function public.business_profile_enabled() returns boolean language sql immutable set search_path = '' as $$ select true $$")
    const speed = await claim('pagespeed', 'mobile')
    await complete(speed, { lighthouseResult: { categories: { performance: { score: 0.7 } } } })
    await identity(owner)
    assert.equal((await report('pagespeed', 'mobile')).sync.cadence, 'daily')
    assert.equal((await history('business_profile', 'locations/10')).comparison.health.find(item => item.kind === 'pagespeed').data.performance, 0.7)
    const crux = await claim('crux', 'PHONE'); await complete(crux, { available: false, reason: 'insufficient_data' })
    await identity(owner); assert.equal((await report('crux', 'PHONE')).data.available, false)
    job = await claim('business_profile')
    await identity(owner); await bind(false)
    await db.exec('reset role; set role service_role'); assert.equal(await complete(job, { location: { title: 'Late write' } }), false)
    await identity(owner); assert.equal((await history('business_profile', 'locations/10')).changes.length, 4, 'unlink retains history')
    await bind(true)
    job = await claim('business_profile')
    await db.exec('reset role'); await db.query('update public.google_connections set generation=gen_random_uuid() where owner_id=$1', [owner])
    await db.exec('set role service_role'); assert.equal(await complete(job, { location: { title: 'Old grant' } }), false)
    await db.exec('reset role'); await db.query("update public.websites set fqdn='renamed.example.com' where id=$1", [site])
    await identity(owner); assert.equal((await history('business_profile', 'locations/10')).changes.length, 0, 'renames isolate history and bindings')
    await db.exec('reset role'); await db.query('delete from public.websites where id=$1', [site])
    assert.equal((await db.query('select count(*)::int as n from public.google_profile_changes')).rows[0].n, 0)
  } finally { await db.close() }
})
