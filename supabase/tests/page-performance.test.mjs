import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('priority samples enforce ownership/bounds and retain distinct history with provenance', async () => {
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
      insert into public.websites(id,owner_id,fqdn) values('${site}','${owner}','example.com');
      insert into public.google_connections(owner_id,encrypted_grant,scopes) values('${owner}','encrypted','{}');`)
    async function identity(user, anonymous = false) {
      await db.exec('reset role; set role authenticated')
      await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, is_anonymous: anonymous })])
    }
    async function request(source, kind = 'pagespeed') {
      return (await db.query('select public.request_google_report($1,$2,$3,current_date-1,current_date) as result', [site, kind, source])).rows[0].result
    }
    async function history(source) {
      return (await db.query("select public.google_insight_history($1,'pagespeed',$2,current_date-1,current_date+1) as result", [site, source])).rows[0].result
    }
    const source = 'mobile|https://example.com/services'
    await identity(other); await assert.rejects(() => request(source), /Website not found/)
    await identity(owner, true); await assert.rejects(() => request(source), /Website not found/)
    await identity(owner)
    for (const invalid of ['mobile|https://other.example/a', 'mobile|http://example.com/a', 'mobile|https://example.com:8443/a', 'mobile|https://example.com/a#b', 'mobile|https://example.com/a\\b', 'PHONE|https://example.com/a', 'mobile|https://example.com/a b']) await assert.rejects(() => request(invalid), /Invalid source/)
    await assert.rejects(() => db.query("select public.valid_performance_source('pagespeed','example.com','mobile')"), /permission denied/)
    await request('mobile'); await request('PHONE', 'crux'); await request(source)
    await request('desktop|https://example.com/services'); await request('PHONE|https://example.com/services', 'crux')
    for (let i = 1; i < 10; i++) await request(`mobile|https://example.com/page-${i}`)
    await assert.rejects(() => request('mobile|https://example.com/eleventh'), /ten active/)
    await request(source)
    await db.exec('reset role')
    const job = (await db.query('select * from public.google_report_jobs where property_id=$1', [source])).rows[0]
    assert.equal(new Date(job.start_date).toISOString().slice(0, 10), '1970-01-01')
    const data = { url: 'https://example.com/services', strategy: 'mobile', measurement: { semantics_version: 1, scope: 'url', mode: 'lab', sample_count: 1, metrics: { 'total-blocking-time': 0 } }, lighthouseResult: { lighthouseVersion: '13', environment: { hostUserAgent: 'test' }, categories: { performance: { score: 0.8 } }, audits: { large: {} } } }
    await db.query('insert into public.google_report_snapshots(job_id,data) values($1,$2)', [job.id, data])
    await identity(owner)
    assert.deepEqual((await request(source)).data, data)
    const saved = await history(source)
    assert.equal(saved.snapshots[0].data.measurement.metrics['total-blocking-time'], 0)
    assert.equal(saved.snapshots[0].data.lighthouseResult.lighthouseVersion, '13')
    assert.deepEqual(saved.snapshots[0].data.lighthouseResult.environment, { hostUserAgent: 'test' })
    assert.equal(saved.snapshots[0].data.lighthouseResult.audits, undefined)
    assert.ok(saved.samples.includes('https://example.com/services'))
    assert.equal((await history('mobile')).snapshots.length, 0)
    await identity(other); await assert.rejects(() => history(source), /Website not found/)
    await db.exec('reset role')
    await db.query("update public.google_report_jobs set refresh_until=now()-interval '1 minute' where property_id like '%|https://example.com/page-1'")
    await identity(owner); await request('mobile|https://example.com/replacement')
    await db.exec('reset role')
    await db.query("update public.google_connections set status='disconnected' where owner_id=$1", [owner])
    await identity(owner); assert.equal((await history(source)).snapshots.length, 1)
    await db.exec('reset role')
    await db.query("update public.websites set fqdn='renamed.example.com' where id=$1", [site])
    await identity(owner); assert.equal((await history(source)).snapshots.length, 0)
  } finally { await db.close() }
})
