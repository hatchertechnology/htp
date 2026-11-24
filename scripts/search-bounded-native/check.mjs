// Disposable local PG17/PostgREST/API stack with signed synthetic identities.
// Exercises the real /websites/{id}/search/dataset HTTP entry point against the
// new bounded database read; no hosted service or live provider is involved.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const api = `http://127.0.0.1:${process.env.API_PORT}`
const site = '00000000-0000-0000-0000-000000000003'
const owner = await readFile(`${process.env.FIXTURE_DIR}/owner.token`, 'utf8')
const other = await readFile(`${process.env.FIXTURE_DIR}/other.token`, 'utf8')
const property = 'sc-domain:www.example.com'

async function call(token, body, id = site) {
  const response = await fetch(`${api}/websites/${id}/search/dataset`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
const request = (overrides = {}) => ({
  site_url: property,
  start_date: '2026-10-01',
  end_date: '2026-10-03',
  dataset: 'queries',
  offset: 0,
  limit: 25,
  ...overrides,
})

// Positive owner read: bounded page plus the existing metadata contract.
let result = await call(owner, request({ limit: 1 }))
assert.equal(result.status, 200)
assert.equal(result.body.available, true)
assert.equal(result.body.rows.length, 1)
assert.equal(result.body.rows[0].keys[0], 'alpha')
assert.equal(result.body.retained_rows, 3)
assert.equal(result.body.has_more, true)
assert.equal(result.body.collection.anonymized_queries, 'excluded')
assert.equal(result.body.collection.truncated, false)
assert.equal(result.body.measurement.provider_completeness, 'not_guaranteed')
assert.equal(result.body.sync.exact_range_available, true)
assert.ok(result.body.sync.snapshot_id)
assert.equal(result.body.sync.state, 'ready')
assert.ok(result.body.daily_sync)
assert.equal(result.body.offset, 0)
assert.equal(result.body.limit, 1)
// Only the requested page is returned, not the whole snapshot. The field set
// is the existing dataset contract (analysis-only keys stay present as null).
assert.deepEqual(Object.keys(result.body).sort(), [
  'available', 'collection', 'comparison', 'coverage', 'daily_sync', 'dataset',
  'has_more', 'limit', 'measurement', 'offset', 'policy', 'reason',
  'retained_rows', 'rows', 'semantics_version', 'sync',
])
assert.equal(result.body.data, undefined)

// Continuation reads the next retained row without re-sending earlier ones.
result = await call(owner, request({ offset: 2, limit: 1 }))
assert.equal(result.body.rows[0].keys[0], 'gamma')
assert.equal(result.body.has_more, false)

// Segment filters apply to retained rows and report omissions. Paging ranks
// the shape-valid, device/country-filtered rows, so interleaved malformed rows
// and rows for other segments never consume a page slot and no page is short
// or duplicated.
result = await call(owner, request({ dataset: 'query_page_segments', device: 'MOBILE', country: 'usa', offset: 0, limit: 2 }))
assert.equal(result.status, 200)
assert.equal(result.body.available, true)
assert.deepEqual(result.body.rows.map((r) => r.clicks), [1, 2])
assert.equal(result.body.rows[0].keys[2], 'MOBILE')
assert.equal(result.body.retained_rows, 5)
assert.equal(result.body.has_more, true)
// Two malformed rows (including a missing `keys` SQL NULL) are counted.
assert.equal(result.body.invalid_rows_omitted, 2)
assert.deepEqual(result.body.filters, { device: 'MOBILE', country: 'usa' })
assert.equal(result.body.filter_scope, 'retained_bounded_rows_only')

result = await call(owner, request({ dataset: 'query_page_segments', device: 'MOBILE', country: 'usa', offset: 1, limit: 2 }))
assert.deepEqual(result.body.rows.map((r) => r.clicks), [2, 3])
assert.equal(result.body.has_more, true)

result = await call(owner, request({ dataset: 'query_page_segments', device: 'MOBILE', country: 'usa', offset: 2, limit: 2 }))
assert.deepEqual(result.body.rows.map((r) => r.clicks), [3, 4])
assert.equal(result.body.has_more, true)

result = await call(owner, request({ dataset: 'query_page_segments', device: 'MOBILE', country: 'usa', offset: 4, limit: 2 }))
assert.deepEqual(result.body.rows.map((r) => r.clicks), [5])
assert.equal(result.body.retained_rows, 5)
assert.equal(result.body.has_more, false)

// A different device/country segment is still reachable on its own page.
result = await call(owner, request({ dataset: 'query_page_segments', device: 'DESKTOP', country: 'usa' }))
assert.deepEqual(result.body.rows.map((r) => r.clicks), [20])
assert.equal(result.body.retained_rows, 1)

// Analysis candidates keep their comparison/coverage/policy metadata, bound
// their evidence, and never carry the sibling landing_outcomes rows.
result = await call(owner, request({ dataset: 'analysis' }))
assert.equal(result.body.available, true)
assert.equal(result.body.rows[0].kind, 'low_ctr_review')
assert.equal(result.body.rows[0].evidence.length, 2)
assert.equal(result.body.rows[0].evidence_presentation.retained_rows, 2)
assert.equal(result.body.rows[0].landing_outcomes, undefined)
assert.ok(!JSON.stringify(result.body).includes('sibling-a'))
assert.equal(result.body.comparison.available, true)
assert.equal(result.body.coverage.scope, 'retained_observations_only')
assert.equal(result.body.policy.min_impressions, 100)

// Landing outcomes use the owned GA4 binding and report currency.
result = await call(owner, request({ dataset: 'landing_outcomes' }))
assert.equal(result.body.available, true)
assert.equal(result.body.rows.length, 2)
assert.equal(result.body.currency_code, 'USD')
assert.ok(result.body.attribution)

// Legacy/unavailable states stay truthful and are not synthesized as zero rows.
result = await call(owner, request({ dataset: 'devices' }))
assert.equal(result.body.available, false)
assert.equal(result.body.reason, 'dataset_unavailable')
assert.deepEqual(result.body.rows, [])
result = await call(owner, request({ start_date: '2020-01-01', end_date: '2020-01-03' }))
assert.equal(result.body.available, false)
assert.equal(result.body.reason, 'exact_period_snapshot_unavailable')
assert.equal(result.body.sync.exact_range_available, false)
result = await call(owner, request({ start_date: '2026-09-01', end_date: '2026-09-03', dataset: 'query_page_segments' }))
assert.equal(result.body.available, false)
assert.equal(result.body.reason, 'segment_collection_unavailable')

// Negative ownership: another authenticated owner cannot read the website.
result = await call(other, request())
assert.equal(result.status, 404)
// Anonymous request is rejected before any database read.
result = await call(null, request())
assert.equal(result.status, 401)
// Missing website is not found.
result = await call(owner, request(), '00000000-0000-0000-0000-0000000000ff')
assert.equal(result.status, 404)
// Request validation is unchanged.
result = await call(owner, request({ limit: 101 }))
assert.equal(result.status, 400)
result = await call(owner, request({ site_url: 'sc-domain:other.example.com' }))
assert.equal(result.status, 400)

console.log('search bounded dataset native checks passed')
