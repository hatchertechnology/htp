import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

// The database function returns the `saved` shape the Rust projection consumes:
// data.<dataset> with only the requested page, sync, daily_sync and `page`
// metadata. The final public envelope (available/reason/rows/retained_rows) is
// assembled by the API projection and covered by the Rust and native tests.
const owner = '00000000-0000-0000-0000-000000000001'
const other = '00000000-0000-0000-0000-000000000002'
const site = '00000000-0000-0000-0000-000000000003'

async function stack() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth,public to authenticated,anon,service_role;`)
  const dir = new URL('../migrations/', import.meta.url)
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(name, dir), 'utf8'))
  }
  await db.query('insert into auth.users values($1),($2)', [owner, other])
  await db.query("insert into public.websites(id,owner_id,fqdn,ga4_property_id) values($1,$2,'example.com','123')", [site, owner])
  await db.query("insert into public.google_connections(owner_id,encrypted_grant,scopes,status) values($1,'','{}','disconnected')", [owner])
  const identity = async (id, anon = false) => {
    await db.exec('reset role; set role authenticated')
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id, is_anonymous: anon })])
  }
  const read = async (dataset, extra = {}) => (await db.query(
    `select public.read_search_dataset_page($1,'search','sc-domain:example.com','2026-10-01','2026-10-03',$2,$3,$4,$5,$6,$7) r`,
    [site, dataset, extra.offset ?? 0, extra.limit ?? 25, extra.device ?? null, extra.country ?? null, extra.maxBytes ?? 262144],
  )).rows[0].r
  const readConversions = async (dataset, extra = {}) => (await db.query(
    `select public.read_search_dataset_page($1,'conversions','123','2026-10-01','2026-10-03',$2,$3,$4,null,null,$5) r`,
    [site, dataset, extra.offset ?? 0, extra.limit ?? 25, extra.maxBytes ?? 262144],
  )).rows[0].r
  return { db, identity, read, readConversions }
}

test('bounded dataset read authorizes the owner, bounds rows and preserves metadata', async () => {
  const { db, identity, read } = await stack()
  try {
    const job = (await db.query(
      `insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date)
       values($1,'example.com','search','sc-domain:example.com','2026-10-01','2026-10-03') returning id`,
      [site],
    )).rows[0].id
    await db.query('insert into public.google_report_snapshots(job_id,data,fetched_at) values($1,$2,now())', [job, {
      queries: { rows: [{ keys: ['a'], clicks: 1 }, { keys: ['b'], clicks: 2 }, { keys: ['c'], clicks: 3 }], collection: { truncated: false, anonymized_queries: 'excluded' } },
      pages: { rows: [{ keys: ['https://example.com/'] }] },
      measurement: { version: 1, provider_completeness: 'not_guaranteed' },
    }])
    await identity(other)
    await assert.rejects(() => read('queries'), /Website not found/)
    await identity(owner, true)
    await assert.rejects(() => read('queries'), /Website not found/)
    await identity(owner)
    const first = await read('queries', { offset: 0, limit: 1 })
    assert.equal(first.sync.exact_range_available, true)
    assert.equal(first.data.queries.rows.length, 1)
    assert.equal(first.data.queries.rows[0].keys[0], 'a')
    assert.equal(first.page.retained_rows, 3)
    assert.equal(first.page.has_more, true)
    assert.equal(first.data.queries.collection.anonymized_queries, 'excluded')
    assert.equal(first.data.measurement.provider_completeness, 'not_guaranteed')
    assert.ok(first.daily_sync.coverage.state)
    const second = await read('queries', { offset: 1, limit: 1 })
    assert.equal(second.data.queries.rows[0].keys[0], 'b')
    assert.equal(second.page.has_more, true)
    const last = await read('queries', { offset: 2, limit: 1 })
    assert.equal(last.data.queries.rows[0].keys[0], 'c')
    assert.equal(last.page.has_more, false)
    const beyond = await read('queries', { offset: 9, limit: 1 })
    assert.deepEqual(beyond.data.queries.rows, [])
    assert.equal(beyond.page.retained_rows, 3)
    assert.equal(beyond.page.has_more, false)
  } finally {
    await db.close()
  }
})

test('bounded dataset read handles segments, legacy, analysis and landing outcomes', async () => {
  const { db, identity, read, readConversions } = await stack()
  try {
    const job = (await db.query(
      `insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date)
       values($1,'example.com','search','sc-domain:example.com','2026-10-01','2026-10-03') returning id`,
      [site],
    )).rows[0].id
    const conversionJob = (await db.query(
      `insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date)
       values($1,'example.com','conversions','123','2026-10-01','2026-10-03') returning id`,
      [site],
    )).rows[0].id
    await db.query('insert into public.google_report_snapshots(job_id,data) values($1,$2)', [job, {
      queries: { rows: [] },
      query_page_segments: { rows: [
        { keys: ['q', 'https://example.com/', 'MOBILE', 'usa'], clicks: 1 },
        { keys: ['q', 'https://example.com/', 'DESKTOP', 'usa'], clicks: 2 },
        { keys: ['q', 'https://example.com/', 'MOBILE', 'can'], clicks: 3 },
        // Malformed/legacy saved rows: a short array, a missing `keys` member
        // (SQL NULL), a legacy non-array type, an explicit JSON null, a bare
        // scalar, a non-string key and an over-long array. Every one must be
        // omitted and counted, never dropped from the count.
        { keys: ['malformed'] },
        { foo: 1 },
        { keys: 'str' },
        { keys: null },
        7,
        { keys: ['a', 'b', 'c', 5] },
        { keys: ['a', 'b', 'c', 'd', 'e'] },
      ], collection: { truncated: true, anonymized_queries: 'excluded' } },
      analysis: {
        semantics_version: 1,
        period: { start_date: '2026-10-01', end_date: '2026-10-03' },
        candidates: [{ kind: 'low_ctr_review', page: '/', evidence: Array.from({ length: 30 }, (_, i) => ({ keys: [String(i)] })) }],
        comparison: { available: true, reason: null },
        coverage: { scope: 'retained_observations_only' },
        policy: { min_impressions: 100 },
        landing_outcomes: { available: true, reason: null, rows: Array.from({ length: 200 }, (_, i) => ({ landing_page: `/${i}` })) },
      },
    }])
    await db.query('insert into public.google_report_snapshots(job_id,data) values($1,$2)', [conversionJob, {
      analysis: { landing_outcomes: { available: true, rows: [
        { landing_page: '/a', metrics: { sessions: 1 }, evidence: { dimensionValues: [{ value: '/a' }] } },
        { landing_page: '/b', metrics: { sessions: 2 }, evidence: { dimensionValues: [{ value: '/b' }] } },
      ], collection: { truncated: false }, attribution: 'all_channels' } },
      pages: { metadata: { currencyCode: 'USD' } },
      measurement: { version: 1 },
    }])
    await identity(owner)
    const segments = await read('query_page_segments', { device: 'MOBILE', country: 'usa', limit: 25 })
    assert.equal(segments.data.query_page_segments.rows.length, 1)
    assert.equal(segments.data.query_page_segments.rows[0].keys[3], 'usa')
    assert.equal(segments.page.retained_rows, 1)
    // Seven malformed rows (including the missing-`keys` SQL NULL) are omitted
    // and counted; the same predicate drives the page and the count.
    assert.equal(segments.page.invalid_rows_omitted, 7)
    const allSegments = await read('query_page_segments', { limit: 25 })
    assert.equal(allSegments.page.retained_rows, 3)
    assert.equal(allSegments.page.invalid_rows_omitted, 7)
    const analysis = await read('analysis', { limit: 25 })
    assert.equal(analysis.data.analysis.candidates.length, 1)
    assert.equal(analysis.data.analysis.candidates[0].kind, 'low_ctr_review')
    // Evidence is bounded in SQL with the same retained/returned counts the
    // public contract reports.
    assert.equal(analysis.data.analysis.candidates[0].evidence.length, 25)
    assert.equal(analysis.data.analysis.candidates[0].evidence_presentation.retained_rows, 30)
    assert.equal(analysis.data.analysis.candidates[0].evidence_presentation.returned_rows, 25)
    assert.equal(analysis.data.analysis.candidates[0].evidence_presentation.truncated, true)
    assert.equal(analysis.data.analysis.comparison.available, true)
    assert.equal(analysis.data.analysis.coverage.scope, 'retained_observations_only')
    // The sibling landing_outcomes rows are never carried on an analysis read,
    // and the analysis object keeps only the consumed metadata.
    assert.equal(analysis.data.analysis.landing_outcomes, undefined)
    assert.equal(analysis.data.analysis.period, undefined)
    assert.ok(!JSON.stringify(analysis).includes('landing_page'))
    const landing = await readConversions('landing_outcomes', { offset: 1, limit: 1 })
    assert.equal(landing.data.analysis.landing_outcomes.available, true)
    assert.equal(landing.data.analysis.landing_outcomes.rows.length, 1)
    assert.equal(landing.data.analysis.landing_outcomes.rows[0].landing_page, '/b')
    assert.equal(landing.page.retained_rows, 2)
    assert.equal(landing.page.has_more, false)
    assert.equal(landing.data.analysis.landing_outcomes.attribution, 'all_channels')
    assert.equal(landing.data.analysis.landing_outcomes.coverage, undefined)
    assert.equal(landing.data.pages.metadata.currencyCode, 'USD')
    // A snapshot whose dataset is absent is unavailable, not an empty success.
    const legacy = await read('devices')
    assert.equal(legacy.sync.exact_range_available, true)
    assert.equal(legacy.data.devices.rows, undefined)
  } finally {
    await db.close()
  }
})

test('bounded dataset read fails closed on missing snapshots, bad input and oversized pages', async () => {
  const { db, identity, read } = await stack()
  try {
    await identity(owner)
    // No exact snapshot yet: explicit unavailable, never older data.
    const missing = await read('queries')
    assert.equal(missing.sync.exact_range_available, false)
    assert.equal(missing.sync.snapshot_id, null)
    assert.equal(missing.data.queries.rows, undefined)
    await assert.rejects(() => read('bogus'), /Invalid search dataset request/)
    await assert.rejects(() => read('queries', { limit: 101 }), /Invalid search dataset request/)
    await assert.rejects(() => read('queries', { device: 'MOBILE' }), /Invalid search dataset request/)
    await assert.rejects(() => read('query_page_segments', { country: 'USA' }), /Invalid search dataset request/)
    await db.exec('reset role')
    const job = (await db.query(
      `insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date)
       values($1,'example.com','search','sc-domain:example.com','2026-10-01','2026-10-03') returning id`,
      [site],
    )).rows[0].id
    await db.query('insert into public.google_report_snapshots(job_id,data) values($1,$2)', [job, {
      queries: { rows: [{ keys: ['x'.repeat(8000)], clicks: 1 }] },
      query_page_segments: { unavailable: true, reason: 'segment_collection_unavailable', rows: [] },
    }])
    await identity(owner)
    // A page larger than the byte budget fails closed instead of truncating and
    // letting the fixed-offset caller skip rows.
    await assert.rejects(() => read('queries', { maxBytes: 4096 }), /search_page_too_large/)
    const normal = await read('queries')
    assert.equal(normal.data.queries.rows.length, 1)
    // Legacy unavailable segment marker is preserved as a reason, not treated
    // as empty and not carried as an unconsumed `unavailable` flag.
    const legacySegments = await read('query_page_segments')
    assert.equal(legacySegments.data.query_page_segments.reason, 'segment_collection_unavailable')
    assert.equal(legacySegments.data.query_page_segments.rows, undefined)
    assert.equal(legacySegments.data.query_page_segments.unavailable, undefined)
  } finally {
    await db.close()
  }
})
