// Normal saved-audit dashboard check for receiver-generated schema-4 summaries.
// Serves repository fixtures through browser interception only: no external
// traffic, no writes, no collection. Run against a built Nitro server:
//   NITRO_PORT=3110 node .output/server/index.mjs
//   node tests/fixtures/check-s14-saved-display.mjs proxy
//   NUXT_PUBLIC_BOUNDED_SAVED_DETAIL=true NITRO_PORT=3111 node .output/server/index.mjs
//   node tests/fixtures/check-s14-saved-display.mjs bounded
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const mode = process.argv[2] === 'bounded' ? 'bounded' : 'proxy'
const origin = new URL('http://127.0.0.1:3105')
if (process.env.NITRO_PORT) origin.port = process.env.NITRO_PORT

const dir = new URL('./s14-saved-display/', import.meta.url)
const load = async name => JSON.parse(await readFile(new URL(name, dir), 'utf8'))
const [completeSummary, partialSummary, omittedSummary, violationSummary, completeReport, partialReport, omittedReport, violationReport] = await Promise.all([
  load('summary-complete-verified.json'), load('summary-partial-mixed.json'), load('summary-partial-omitted.json'), load('summary-violation.json'),
  load('report-complete-verified.json'), load('report-partial-mixed.json'), load('report-partial-omitted.json'), load('report-violation.json'),
])

const site = '00000000-0000-0000-0000-000000000003'
const user = '00000000-0000-0000-0000-000000000001'
const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000d', '00000000-0000-4000-8000-00000000000e']
const time = '2026-11-16T12:02:00Z'
const exp = Math.floor(Date.now() / 1000) + 3600
const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user, exp })).toString('base64url')}.fake`

// The last run is a real schema-4 report with a future summary version; the
// dashboard must say it is unsupported rather than showing any claim.
const details = [
  { delivery_id: ids[0], scan_at: '2026-11-16T12:01:00Z', received_at: time, ingestion_source: 'worker', summary: completeSummary, report: completeReport, source_sha256: 'sha256:2443936d93da699595bdb135995e3d1d1503b96d973f5be4f3b82d9f243f4342', source_bytes: 26567 },
  { delivery_id: ids[1], scan_at: '2026-11-16T12:00:00Z', received_at: time, ingestion_source: 'worker', summary: partialSummary, report: partialReport, source_sha256: 'sha256:e95085661f1cbddc165e3acf47fb05a69e47bbe6c4be4dbffe480b385f15902e', source_bytes: 26829 },
  { delivery_id: ids[2], scan_at: '2026-11-16T11:59:00Z', received_at: time, ingestion_source: 'import', summary: omittedSummary, report: omittedReport, source_sha256: 'sha256:9cd361d79c93e40ddb57b0043c201fea0090836c500dd726849d055ec6b5efe9', source_bytes: 425640 },
  { delivery_id: ids[3], scan_at: '2026-11-16T11:58:00Z', received_at: time, ingestion_source: 'worker', summary: violationSummary, report: violationReport, source_sha256: 'sha256:530c1c822d56ad151a8d9c17bc39b6c9a8c5ad6d103699af01917319e8e54139', source_bytes: 44834 },
  { delivery_id: ids[4], scan_at: '2026-11-16T11:57:00Z', received_at: time, ingestion_source: 'worker', summary: { ...completeSummary, summary_version: 6 }, report: completeReport },
]
const runs = details.map(({ report, ...run }) => run)
const ruleTotals = coverage => {
  const claims = Object.values(coverage ?? {}).map(rule => rule.coverage !== 'complete_verified' ? 'unverified' : rule.reported_findings > 0 ? 'findings' : 'clean')
  return { clean: claims.filter(claim => claim === 'clean').length, findings: claims.filter(claim => claim === 'findings').length, unknown: claims.filter(claim => claim === 'unverified').length }
}
const completeTotals = ruleTotals(completeSummary.rule_coverage), partialTotals = ruleTotals(partialSummary.rule_coverage), omittedTotals = ruleTotals(omittedSummary.rule_coverage), violationTotals = ruleTotals(violationSummary.rule_coverage)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = [], calls = []
page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(({ token, exp, user }) => localStorage.setItem('sb-raxuvdbdfmmtpqjcafcq-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fake', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: user, aud: 'authenticated', role: 'authenticated' } })), { token, exp, user })
await page.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url()), path = url.pathname
  const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  if (url.hostname === 'raxuvdbdfmmtpqjcafcq.supabase.co' && path.includes('/auth/v1/')) return json({ id: user, aud: 'authenticated' })
  if (url.hostname !== '127.0.0.1') { calls.push(`BLOCKED ${request.method()} ${url.hostname}${path}`); return route.abort() }
  if (path.startsWith('/api/')) {
    calls.push(`${request.method()} ${path}`)
    if (request.method() !== 'GET') { calls.push(`ABORTED ${request.method()} ${path}`); return route.abort() }
    if (path === '/api/websites') return json({ items: [{ id: site, fqdn: 'example.com' }], has_more: false })
    if (path === `/api/websites/${site}/seo/audits`) return json({ items: runs, has_more: false, next_cursor: null })
    const bounded = path.match(/\/seo\/audits\/([^/]+)\/dashboard$/)
    if (bounded) return json(details.find(detail => detail.delivery_id === bounded[1]))
    const detail = path.match(/\/seo\/audits\/([^/]+)$/)
    if (detail) return json(details.find(d => d.delivery_id === detail[1]))
    return json({ connected: false, configured: false })
  }
  return route.continue()
})

try {
  await page.goto(origin.href, { waitUntil: 'domcontentloaded' })
  const panel = page.getByRole('region', { name: 'Receiver-verified semantics' })
  await panel.waitFor()

  // Run A: complete-verified receiver summary with sparse severities.
  assert.match(await page.locator('.seo-summary').innerText(), /Critical0/)
  assert.match(await panel.innerText(), /Complete verified/)
  assert.match(await panel.innerText(), new RegExp(`${completeTotals.clean} verified clean within retained scope`))
  assert.doesNotMatch(await panel.innerText(), /Unknown — absence is not a pass/)
  await panel.getByRole('button', { name: `Show ${completeTotals.clean} verified-clean rules` }).waitFor()
  assert.ok(await panel.locator('table').last().getByRole('row', { name: /missing h1/ }).count() >= 1)
  // The retained source binding is stored beside, not inside, the summary.
  assert.ok(await panel.getByText(/2443936d93da699595bdb135995e3d1d1503b96d973f5be4f3b82d9f243f4342/).count() >= 1)
  assert.ok(await panel.getByText(/26567 bytes/).count() >= 1)
  assert.ok(await panel.getByText(/stored separately from the canonical summary/).count() >= 1)

  // Run B: mixed per-rule coverage stays partial; unknown rules are listed.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[1])
  await panel.getByText(/Partial or unknown/).waitFor()
  assert.match(await panel.innerText(), new RegExp(`${partialTotals.clean} verified clean within retained scope · ${partialTotals.findings} with a finding · ${partialTotals.unknown} unknown`))
  assert.match(await panel.innerText(), /Unknown — absence is not a pass/)

  // Run C: omitted records stay explicit and every rule remains unknown.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[2])
  await panel.getByText(/were omitted; omitted evidence is unknown/).waitFor()
  assert.match(await panel.innerText(), new RegExp(`${omittedTotals.unknown} unknown`))
  assert.equal(omittedTotals.clean, 0)
  assert.equal(await panel.locator('[data-record-count="unknown"]').innerText(), String(omittedSummary.record_counts.unknown))

  // Run D: receiver-reported policy violations are distinct from advisories.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[3])
  await panel.getByText(/Partial or unknown/).waitFor()
  assert.equal(await panel.locator('[data-record-count="violation"]').innerText(), String(violationSummary.record_counts.violation))
  assert.equal(await panel.locator('[data-record-count="advisory_triggered"]').innerText(), String(violationSummary.record_counts.advisory_triggered))
  assert.equal(violationTotals.clean, 0)

  // Run E: a future summary version is explicitly unsupported, with no claims.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[4])
  await panel.getByText(/only version 5 is supported here/).waitFor()
  assert.equal(await panel.locator('table').count(), 0)
  // Schema 4 never shows the legacy evidence-contract panel, which would read as unknown.
  assert.equal(await page.getByRole('region', { name: 'Evidence and coverage' }).count(), 0)

  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[0])
  await panel.getByText(/Complete verified/).waitFor()
  await page.screenshot({ path: `/tmp/htp-s14-saved-display-${mode}.png`, fullPage: true })

  assert.deepEqual(errors, [])
  const detailCalls = calls.filter(call => /\/seo\/audits\/[^/]+(\/dashboard)?$/.test(call.split(' ')[1] ?? ''))
  if (mode === 'bounded') {
    assert.ok(detailCalls.length > 0 && detailCalls.every(call => call.includes('/dashboard')), detailCalls.join('\n'))
  } else {
    assert.ok(detailCalls.length > 0 && detailCalls.every(call => !/\/seo\/audits\/[^/]+\/dashboard/.test(call)), detailCalls.join('\n'))
    assert.ok(!calls.some(call => /\/seo\/audits\/[^/]+\/dashboard/.test(call)), calls.join('\n'))
  }
  assert.ok(!calls.some(call => call.startsWith('BLOCKED')), calls.join('\n'))
  assert.ok(calls.filter(call => /^(POST|PUT|PATCH|DELETE) /.test(call)).every(call => calls.includes(`ABORTED ${call}`)))
  assert.ok(!calls.some(call => /^(POST|PUT|PATCH|DELETE) .*\/seo\/audits/.test(call)))
  console.log(`PASS: schema-4 receiver semantics in the normal dashboard (${mode} saved-read transport); complete, mixed partial, omitted and violation runs; future summary explicitly unsupported; reads only, no external traffic`)
  console.log(calls.join('\n'))
} finally {
  await browser.close()
}
