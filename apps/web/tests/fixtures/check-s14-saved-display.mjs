// Normal saved-audit dashboard check for receiver-generated schema-4 summaries.
// Serves repository fixtures through browser interception only: no external
// traffic, no writes, no collection. The retained report bytes are served as
// the exact `report_json` an API detail returns, and the checker performs real
// browser downloads and hashes the resulting bytes against the fixture pins.
// Run against a built Nitro server:
//   NITRO_PORT=3110 node .output/server/index.mjs
//   node tests/fixtures/check-s14-saved-display.mjs proxy
//   NUXT_PUBLIC_BOUNDED_SAVED_DETAIL=true NITRO_PORT=3111 node .output/server/index.mjs
//   node tests/fixtures/check-s14-saved-display.mjs bounded
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const mode = process.argv[2] === 'bounded' ? 'bounded' : 'proxy'
const origin = new URL('http://127.0.0.1:3105')
if (process.env.NITRO_PORT) origin.port = process.env.NITRO_PORT

const dir = new URL('./s14-saved-display/', import.meta.url)
const load = async name => JSON.parse(await readFile(new URL(name, dir), 'utf8'))
const read = async name => readFile(new URL(name, dir), 'utf8')
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

const summaryNames = ['summary-complete-verified.json', 'summary-partial-mixed.json', 'summary-partial-omitted.json', 'summary-violation.json']
const reportNames = ['report-complete-verified.json', 'report-partial-mixed.json', 'report-partial-omitted.json', 'report-violation.json']
const [completeSummary, partialSummary, omittedSummary, violationSummary, completeReport, partialReport, omittedReport, violationReport] = await Promise.all([...summaryNames, ...reportNames].map(load))
// Exact retained summary text as the receiver emitted it. Never re-serialize the
// parsed object and call it canonical: JSONB/object ordering can change bytes.
const summaryTexts = await Promise.all(summaryNames.map(read))
const summaryShas = summaryTexts.map(sha256)
const summaryObjects = summaryTexts.map(text => JSON.parse(text))
for (const [i, text] of summaryTexts.entries()) assert.equal(text, JSON.stringify(summaryObjects[i]), summaryNames[i])
// The exact retained report bytes, not a re-serialization of the parsed report.
const rawReports = await Promise.all(reportNames.map(read))
const sourceShas = rawReports.map(report => sha256(report))

// Native e2e pair: the receiver's real summary text plus a parsed object that
// PostgreSQL JSONB reordered. The reordered object must never be hashed as the
// receiver summary, so its serialization differs from the retained text.
const e2eSummaryText = await read('summary-native-e2e.json')
const e2eSummaryReordered = await load('summary-native-e2e.jsonb.json')
const e2eSummarySha = 'f55ee1b3390b05a33e2001dd7b3f5891e099698d331942b9e56bf0e68c9c5b27'
const e2eReportText = await read('report-native-e2e.json')
const e2eSourceSha = '2c59c8eff03997d98f7ad1c49d513a030faf6bd37fa3edbee52e76d8606e25a1'
assert.equal(sha256(e2eSummaryText), e2eSummarySha)
assert.equal(sha256(e2eReportText), e2eSourceSha)
assert.notEqual(JSON.stringify(e2eSummaryReordered), e2eSummaryText)

const site = '00000000-0000-0000-0000-000000000003'
const user = '00000000-0000-0000-0000-000000000001'
const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000d', '00000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-00000000000f', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012']
const time = '2026-11-16T12:02:00Z'
const exp = Math.floor(Date.now() / 1000) + 3600
const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user, exp })).toString('base64url')}.fake`

// Each of the first four runs pairs the receiver summary text with the exact
// bytes of its retained source report and the true stored source binding. Run E
// is a real schema-4 report with a future summary version; the dashboard must
// say it is unsupported rather than showing any claim. Run F is a supported
// summary whose retained raw bytes are absent, so its export must be labeled
// reconstructed and must never be offered for digest comparison. Run G is the
// native e2e pair whose parsed summary was JSONB-reordered. Run H has no
// retained summary text. Run I carries summary text whose digest does not match
// the stored binding.
const details = [
  { delivery_id: ids[0], scan_at: '2026-11-16T12:01:00Z', received_at: time, ingestion_source: 'worker', summary: completeSummary, summary_text: summaryTexts[0], summary_sha256: summaryShas[0], summary_bytes: Buffer.byteLength(summaryTexts[0]), report: completeReport, report_json: rawReports[0], source_sha256: `sha256:${sourceShas[0]}`, source_bytes: Buffer.byteLength(rawReports[0]) },
  { delivery_id: ids[1], scan_at: '2026-11-16T12:00:00Z', received_at: time, ingestion_source: 'worker', summary: partialSummary, summary_text: summaryTexts[1], summary_sha256: summaryShas[1], summary_bytes: Buffer.byteLength(summaryTexts[1]), report: partialReport, report_json: rawReports[1], source_sha256: `sha256:${sourceShas[1]}`, source_bytes: Buffer.byteLength(rawReports[1]) },
  { delivery_id: ids[2], scan_at: '2026-11-16T11:59:00Z', received_at: time, ingestion_source: 'import', summary: omittedSummary, summary_text: summaryTexts[2], summary_sha256: summaryShas[2], summary_bytes: Buffer.byteLength(summaryTexts[2]), report: omittedReport, report_json: rawReports[2], source_sha256: `sha256:${sourceShas[2]}`, source_bytes: Buffer.byteLength(rawReports[2]) },
  { delivery_id: ids[3], scan_at: '2026-11-16T11:58:00Z', received_at: time, ingestion_source: 'worker', summary: violationSummary, summary_text: summaryTexts[3], summary_sha256: summaryShas[3], summary_bytes: Buffer.byteLength(summaryTexts[3]), report: violationReport, report_json: rawReports[3], source_sha256: `sha256:${sourceShas[3]}`, source_bytes: Buffer.byteLength(rawReports[3]) },
  { delivery_id: ids[4], scan_at: '2026-11-16T11:57:00Z', received_at: time, ingestion_source: 'worker', summary: { ...completeSummary, summary_version: 6 }, report: completeReport },
  { delivery_id: ids[5], scan_at: '2026-11-16T11:56:00Z', received_at: time, ingestion_source: 'worker', summary: completeSummary, summary_text: summaryTexts[0], summary_sha256: summaryShas[0], summary_bytes: Buffer.byteLength(summaryTexts[0]), report: completeReport, source_sha256: `sha256:${sourceShas[0]}`, source_bytes: Buffer.byteLength(rawReports[0]) },
  { delivery_id: ids[6], scan_at: '2026-11-16T11:55:00Z', received_at: time, ingestion_source: 'worker', summary: e2eSummaryReordered, summary_text: e2eSummaryText, summary_sha256: e2eSummarySha, summary_bytes: Buffer.byteLength(e2eSummaryText), report: JSON.parse(e2eReportText), report_json: e2eReportText, source_sha256: e2eSourceSha, source_bytes: Buffer.byteLength(e2eReportText) },
  { delivery_id: ids[7], scan_at: '2026-11-16T11:54:00Z', received_at: time, ingestion_source: 'worker', summary: e2eSummaryReordered, summary_sha256: e2eSummarySha, summary_bytes: Buffer.byteLength(e2eSummaryText), report: JSON.parse(e2eReportText), report_json: e2eReportText, source_sha256: e2eSourceSha, source_bytes: Buffer.byteLength(e2eReportText) },
  { delivery_id: ids[8], scan_at: '2026-11-16T11:53:00Z', received_at: time, ingestion_source: 'worker', summary: e2eSummaryReordered, summary_text: e2eSummaryText, summary_sha256: '0'.repeat(64), summary_bytes: Buffer.byteLength(e2eSummaryText), report: JSON.parse(e2eReportText), report_json: e2eReportText, source_sha256: e2eSourceSha, source_bytes: Buffer.byteLength(e2eReportText) },
]
// Run J: a supported summary that omits the rule_coverage map. Missing coverage
// is unknown, never a population of verified-clean rules.
const noCoverageId = '00000000-0000-4000-8000-000000000013'
const noCoverageSummary = { ...partialSummary }
delete noCoverageSummary.rule_coverage
details.push({ ...details[1], delivery_id: noCoverageId, summary: noCoverageSummary, summary_text: undefined, summary_sha256: undefined })
// Run K: a v5 summary with no severity map. That map is required for v5, so the
// detail is refused and the trend leaves a gap rather than plotting 0.
const noSeveritiesId = '00000000-0000-4000-8000-000000000017'
const noSeveritiesSummary = { ...partialSummary }
delete noSeveritiesSummary.severities
details.push({ ...details[1], delivery_id: noSeveritiesId, scan_at: '2026-11-16T11:52:00Z', summary: noSeveritiesSummary, summary_text: undefined, summary_sha256: undefined, summary_bytes: undefined })
// Runs P1/P2 are an equal-schema (4/4) pair with a shared comparison key, engine
// and ruleset; Q is an older schema-2 run with the same key. Selecting P2 must
// offer no comparison against Q (2/4), while P1 against P2 (4/4) is offered.
const pairId = ['00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-000000000016']
const pairSummary = { ...completeSummary, comparison_key: 'sha256:pair' }
details.push({ ...details[0], delivery_id: pairId[0], scan_at: '2026-11-16T11:40:00Z', summary: { ...pairSummary, finished_at: '2026-11-16T11:40:30Z' } })
details.push({ ...details[0], delivery_id: pairId[1], scan_at: '2026-11-16T11:39:00Z', summary: { ...pairSummary, finished_at: '2026-11-16T11:39:30Z' } })
details.push({ ...details[0], delivery_id: pairId[2], scan_at: '2026-11-16T11:38:00Z', summary: { ...pairSummary, schema_version: 2, finished_at: '2026-11-16T11:38:30Z' } })
const runs = details.map(({ report, report_json, ...run }) => run)
const ruleTotals = coverage => {
  const claims = Object.values(coverage ?? {}).map(rule => rule.coverage !== 'complete_verified' ? 'unverified' : rule.reported_findings > 0 ? 'findings' : 'clean')
  return { clean: claims.filter(claim => claim === 'clean').length, findings: claims.filter(claim => claim === 'findings').length, unknown: claims.filter(claim => claim === 'unverified').length }
}
const completeTotals = ruleTotals(completeSummary.rule_coverage), partialTotals = ruleTotals(partialSummary.rule_coverage), omittedTotals = ruleTotals(omittedSummary.rule_coverage), violationTotals = ruleTotals(violationSummary.rule_coverage)

const authInit = ({ token, exp, user }) => localStorage.setItem('sb-raxuvdbdfmmtpqjcafcq-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fake', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: user, aud: 'authenticated', role: 'authenticated' } }))
// One route handler for every page: intercepts auth and saved-detail GETs,
// aborts mutation requests and blocks non-loopback traffic. The log is per page
// so the no-Web-Crypto page cannot pollute the transport assertions.
function installRoutes(target, log) {
  return target.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
    if (url.hostname === 'raxuvdbdfmmtpqjcafcq.supabase.co' && path.includes('/auth/v1/')) return json({ id: user, aud: 'authenticated' })
    if (url.hostname !== '127.0.0.1') { log.push(`BLOCKED ${request.method()} ${url.hostname}${path}`); return route.abort() }
    if (path.startsWith('/api/')) {
      log.push(`${request.method()} ${path}`)
      if (request.method() !== 'GET') { log.push(`ABORTED ${request.method()} ${path}`); return route.abort() }
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
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York', locale: 'en-US' })
const errors = [], calls = []
page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(authInit, { token, exp, user })
await installRoutes(page, calls)

// Download a named button and return the exact bytes the browser saved.
async function downloadBytes(name, target = page) {
  const [download] = await Promise.all([target.waitForEvent('download'), target.getByRole('button', { name, exact: true }).click()])
  const bytes = await readFile(await download.path())
  return { bytes, text: bytes.toString('utf8'), sha: createHash('sha256').update(bytes).digest('hex') }
}

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
  assert.ok(await panel.getByText(new RegExp(sourceShas[0])).count() >= 1)
  assert.ok(await panel.getByText(new RegExp(String(details[0].source_bytes) + ' bytes')).count() >= 1)
  assert.ok(await panel.getByText(/stored separately from the summary/).count() >= 1)
  assert.ok(await panel.getByText(/byte-identical/).count() >= 1)
  // The retained summary text digest, not the source digest, is what the summary download hashes.
  assert.ok(await panel.getByText(new RegExp(summaryShas[0].slice(0, 16))).count() >= 1)
  assert.ok(await panel.getByText(/matches the stored summary digest/).count() >= 1)
  assert.ok(await panel.getByText(new RegExp(String(details[0].summary_bytes) + ' bytes')).count() >= 1)
  const summaryDownload = await downloadBytes('Download receiver summary')
  assert.equal(summaryDownload.text, summaryTexts[0])
  assert.equal(summaryDownload.sha, summaryShas[0])
  assert.notEqual(summaryDownload.sha, sourceShas[0])
  assert.equal(summaryDownload.bytes.length, Buffer.byteLength(summaryTexts[0]))

  // Run A download: exact retained report bytes, verified by SHA-256, not a label.
  const completeDownload = await downloadBytes('Download run JSON')
  assert.equal(completeDownload.text, rawReports[0])
  assert.equal(completeDownload.sha, sourceShas[0])
  assert.equal(completeDownload.bytes.length, details[0].source_bytes)

  // Run B: mixed per-rule coverage stays partial; unknown rules are listed.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[1])
  await panel.getByText(/Partial or unknown/).waitFor()
  assert.match(await panel.innerText(), new RegExp(`${partialTotals.clean} verified clean within retained scope · ${partialTotals.findings} with a finding · ${partialTotals.unknown} unknown`))
  assert.match(await panel.innerText(), /Unknown — absence is not a pass/)
  const mixedDownload = await downloadBytes('Download run JSON')
  assert.equal(mixedDownload.text, rawReports[1])
  assert.equal(mixedDownload.sha, sourceShas[1])

  // Run C: omitted records stay explicit and every rule remains unknown.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[2])
  await panel.getByText(/were omitted; omitted evidence is unknown/).waitFor()
  assert.match(await panel.innerText(), new RegExp(`${omittedTotals.unknown} unknown`))
  assert.equal(omittedTotals.clean, 0)
  assert.equal(await panel.locator('[data-record-count="unknown"]').innerText(), String(omittedSummary.record_counts.unknown))
  const omittedDownload = await downloadBytes('Download run JSON')
  assert.equal(omittedDownload.text, rawReports[2])
  assert.equal(omittedDownload.sha, sourceShas[2])

  // Run D: receiver-reported policy violations are distinct from advisories.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[3])
  await panel.getByText(/Partial or unknown/).waitFor()
  assert.equal(await panel.locator('[data-record-count="violation"]').innerText(), String(violationSummary.record_counts.violation))
  assert.equal(await panel.locator('[data-record-count="advisory_triggered"]').innerText(), String(violationSummary.record_counts.advisory_triggered))
  assert.equal(violationTotals.clean, 0)
  const violationDownload = await downloadBytes('Download run JSON')
  assert.equal(violationDownload.text, rawReports[3])
  assert.equal(violationDownload.sha, sourceShas[3])

  // Run E: a future summary version is explicitly unsupported, with no claims.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[4])
  await panel.getByText(/only version 5 is supported here/).waitFor()
  assert.equal(await panel.locator('table').count(), 0)
  // Schema 4 never shows the legacy evidence-contract panel, which would read as unknown.
  assert.equal(await page.getByRole('region', { name: 'Evidence and coverage' }).count(), 0)

  // Run F: supported summary, raw report bytes absent. The export is labeled
  // reconstructed and the panel drops any instruction to compare it to the digest.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[5])
  await panel.getByText(/Complete verified/).waitFor()
  assert.ok(await panel.getByText(/reconstructed export from the parsed report/).count() >= 1)
  assert.ok(await panel.getByText(/cannot be compared to this source digest/).count() >= 1)
  assert.equal(await panel.getByText(/compare the downloaded raw report by this retained digest/i).count(), 0)
  const reconstructed = JSON.stringify(completeReport, null, 2)
  const reconstructedDownload = await downloadBytes('Download run JSON')
  assert.equal(reconstructedDownload.text, reconstructed)
  assert.notEqual(reconstructedDownload.text, rawReports[0])
  assert.notEqual(reconstructedDownload.sha, sourceShas[0])

  // Run G: real receiver summary text with a JSONB-reordered parsed object. The
  // download must be the retained text, not JSON.stringify(reordered object).
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[6])
  await panel.getByText(/Partial or unknown/).waitFor()
  assert.notEqual(JSON.stringify(e2eSummaryReordered), e2eSummaryText)
  assert.ok(await panel.getByText(/matches the stored summary digest/).count() >= 1)
  assert.ok(await panel.getByText(new RegExp(e2eSummarySha.slice(0, 16))).count() >= 1)
  const e2eSummaryDownload = await downloadBytes('Download receiver summary')
  assert.equal(e2eSummaryDownload.text, e2eSummaryText)
  assert.equal(e2eSummaryDownload.sha, e2eSummarySha)
  assert.notEqual(e2eSummaryDownload.text, JSON.stringify(e2eSummaryReordered))
  assert.equal(e2eSummaryDownload.bytes.length, Buffer.byteLength(e2eSummaryText))
  const e2eReportDownload = await downloadBytes('Download run JSON')
  assert.equal(e2eReportDownload.text, e2eReportText)
  assert.equal(e2eReportDownload.sha, e2eSourceSha)

  // Run H: no retained summary text. The summary digest is a reconstruction and
  // must not be presented as receiver-canonical or compared with the binding.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[7])
  await panel.getByText(/Partial or unknown/).waitFor()
  assert.ok(await panel.getByText(/Retained summary text is not stored with this detail/).count() >= 1)
  assert.ok(await panel.getByText(/reconstructed JSON serialization/).count() >= 1)
  assert.ok(await panel.getByText(/not receiver-canonical/).count() >= 1)
  assert.equal(await panel.getByText(/matches the stored summary digest/).count(), 0)
  const absentTextDownload = await downloadBytes('Download reconstructed summary')
  assert.equal(absentTextDownload.text, JSON.stringify(e2eSummaryReordered))
  assert.notEqual(absentTextDownload.sha, e2eSummarySha)
  assert.notEqual(absentTextDownload.text, e2eSummaryText)
  // Run I: retained summary text whose digest does not match the stored binding.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[8])
  await panel.getByText(/Partial or unknown/).waitFor()
  assert.ok(await panel.getByText(/does not match the stored summary digest/).count() >= 1)
  const mismatchDownload = await downloadBytes('Download receiver summary')
  assert.equal(mismatchDownload.text, e2eSummaryText)
  assert.equal(mismatchDownload.sha, e2eSummarySha)
  assert.notEqual(mismatchDownload.sha, '0'.repeat(64))

  // Run J: an absent rule_coverage map is unavailable coverage, not a verified
  // population. The all-clean sentence and the 0/0/0 totals must not appear.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(noCoverageId)
  await panel.getByText(/Per-rule coverage is unavailable/).waitFor()
  const noCoverageText = await panel.textContent()
  assert.match(noCoverageText, /Per-rule claim scope \(unavailable\)/)
  assert.doesNotMatch(noCoverageText, /Every reported rule is verified clean within retained scope/)
  assert.doesNotMatch(noCoverageText, /0 verified clean within retained scope/)

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

  // No-Web-Crypto fallback: a digest that cannot be computed is unknown, not a
  // mismatch. The downloaded bytes still hash to the stored binding.
  const noCryptoCalls = [], noCryptoErrors = []
  const noCryptoPage = await browser.newPage({ viewport: { width: 390, height: 844 } })
  noCryptoPage.on('pageerror', error => noCryptoErrors.push(error.message))
  await noCryptoPage.addInitScript(authInit, { token, exp, user })
  await noCryptoPage.addInitScript(() => Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true }))
  await installRoutes(noCryptoPage, noCryptoCalls)
  await noCryptoPage.goto(origin.href, { waitUntil: 'domcontentloaded' })
  const noCryptoPanel = noCryptoPage.getByRole('region', { name: 'Receiver-verified semantics' })
  await noCryptoPanel.waitFor()
  const noCryptoText = await noCryptoPanel.textContent()
  assert.match(noCryptoText, /could not be computed because Web Crypto is unavailable/)
  assert.doesNotMatch(noCryptoText, /does not match the stored summary digest/)
  assert.doesNotMatch(noCryptoText, /does not match this binding/)
  const noCryptoDownload = await downloadBytes('Download receiver summary', noCryptoPage)
  assert.equal(noCryptoDownload.sha, summaryShas[0])
  assert.deepEqual(noCryptoErrors, [])
  assert.ok(!noCryptoCalls.some(call => call.startsWith('BLOCKED')), noCryptoCalls.join('\n'))
  assert.ok(noCryptoCalls.filter(call => /^(POST|PUT|PATCH|DELETE) /.test(call)).every(call => noCryptoCalls.includes(`ABORTED ${call}`)))
  await noCryptoPage.close()

  // Owner decision: the UI shows viewer-local time with a zone label; the UTC
  // instant stays in <time datetime>/title. The semantics panel follows it.
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[0])
  await panel.getByText(/Complete verified/).waitFor()
  await panel.locator('summary', { hasText: 'Provenance and raw digests' }).click()
  const received = panel.locator(`time[datetime="${time}"]`)
  assert.equal(await received.getAttribute('title'), time)
  assert.match(await received.innerText(), /^Nov 16, 2026, 7:02 AM EST$/)
  assert.doesNotMatch(await panel.locator('details').first().innerText(), / UTC\b/)

  // Reconstructed exports are named so; exact retained bytes keep the plain name.
  const filename = async (target, name) => { const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name, exact: true }).click()]); return download.suggestedFilename() }
  assert.equal(await filename(page, 'Download run JSON'), `seosmith-${ids[0]}.json`)
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(ids[5])
  await panel.getByText(/Complete verified/).waitFor()
  assert.equal(await filename(page, 'Download run JSON'), `seosmith-${ids[5]}-reconstructed.json`)

  // A zero-critical schema-4 run is a plotted point of 0, not a gap. A summary
  // with no severity map is unknown, so it is not plotted at all.
  await page.getByLabel('Audit chart metric').selectOption('critical')
  const plotted = await page.locator('.seo-trend svg circle').count()
  assert.equal(plotted, runs.length - 1, 'every run with a scan time and a severity map plots, including zero-critical runs; a missing severity map is a gap')
  assert.match(await page.locator('.seo-trend svg circle').first().getAttribute('aria-label'), /: 0 Critical findings/)

  // Comparison gates: 4/4 with matching key is offered; 4 against 2 is not.
  const compare = page.getByRole('button', { name: 'Compare findings with baseline', exact: true })
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(pairId[0])
  await page.getByLabel('Comparison baseline').waitFor()
  assert.equal(await compare.count(), 1, '4/4 pair offers comparison')
  await page.getByLabel('Inspect a run', { exact: true }).selectOption(pairId[1])
  await page.getByLabel('Comparison baseline').waitFor()
  assert.equal(await compare.count(), 0, '4 against 2 offers no comparison')
  await page.getByText(/Finding changes are unavailable against the selected baseline because .* schema version/).waitFor()

  console.log(`PASS: schema-4 receiver semantics in the normal dashboard (${mode} saved-read transport); complete, mixed partial, omitted and violation runs; future summary explicitly unsupported; retained summary text and retained report downloads verified by SHA-256; JSONB-reordered parsed summary not treated as receiver bytes; absent summary text and summary digest mismatch labeled; reconstructed exports labeled when bytes are absent; missing rule_coverage shown as unavailable instead of all-clean; unavailable digest computation distinct from a mismatch; reads only, no external traffic`)
  console.log(calls.join('\n'))
} catch (error) {
  console.error('page errors:', errors)
  console.error('calls:', calls.join('\n'))
  console.error('body:', (await page.locator('body').innerText().catch(() => '')).slice(0, 4000))
  throw error
} finally {
  await browser.close()
}
