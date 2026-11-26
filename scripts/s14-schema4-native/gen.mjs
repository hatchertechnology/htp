// Synthetic schema-4 report + summary generator for the H2 database tests and the
// N-M3 commit timing. SQL-valid only: it is NOT receiver-admissible (the findings are
// not the full population), because the database binds bytes, not admission.
// Shape mirrors S2's exact-cap schema-4 fixture (512 evaluations, 128 observations,
// truncated evidence) until that fixture exists; pass --report/--summary to the runner
// to time the real one instead.
//
//   node gen.mjs <out-dir> <request_id> <website_id> <generation> [target-bytes]
//   writes <out-dir>/report.json and <out-dir>/summary.json
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const CAP = 4952756
export const REVISION = 's14-wire-1/full-population-1/evidence-v1'
const contracts = new URL('../../supabase/tests/fixtures/contracts/', import.meta.url)
const v2 = JSON.parse(readFileSync(new URL('v2-complete.json', contracts), 'utf8'))
const sha = value => createHash('sha256').update(value).digest('hex')
const entity = url => 'sha256:' + sha('seosmith-entity-v1\npage\n' + url)
const FAIL_RULES = ['deadend', 'little_content', 'missing_language', 'missing_description']
const RULES = v2.evidence_contract.coverage.map(c => c.rule)

const page = (i, links) => ({
  ...structuredClone(v2.pages[0]),
  url: `https://example.com/p/${i}`,
  title: `Synthetic page ${i}`,
  links: Array.from({ length: links }, (_, j) => ({ url: `https://example.com/p/${(i + j + 1) % 100000}`, text: `link ${j}`, rel: '' })),
})

// n pages; the first `observed` get observations; with evidence, `observed` x 4 rules fail.
export function buildReport({ requestId, websiteId, generation = 1, pages = 600, observed = 128, links = 0, evidence = true }) {
  const request = { ...v2.request, request_id: requestId, website_id: websiteId, binding_generation: generation }
  const ps = Array.from({ length: pages }, (_, i) => page(i, links))
  const findings = []
  const evaluations = []
  const observations = []
  const obs = Math.min(observed, pages)
  for (let i = 0; i < obs; i++) {
    observations.push({ entity_id: entity(ps[i].url), source_locator: `/pages/${i}`, state: 'available', unknown_reason: null })
  }
  for (const rule of FAIL_RULES) {
    for (let i = 0; i < obs; i++) {
      const n = findings.length
      const key = sha(`${rule}\n${ps[i].url}`)
      findings.push({ key, rule, severity: 'warning', url: ps[i].url, evidence: 'synthetic', evidence_items: ['synthetic'], details: {} })
      evaluations.push({
        entity_id: entity(ps[i].url), rule, rule_version: v2.ruleset_version, validator_version: 's01-1',
        eligibility: 'eligible', attempt: 'completed', outcome: 'fail', unknown_reason: null,
        source_locator: `/findings/${n}`,
        actual: { state: 'source', source_locator: `/findings/${n}/evidence_items` },
        expected: { state: 'unavailable', reason: 'legacy_expectation_not_recorded' },
        confidence: 'high', finding_key: key,
      })
    }
  }
  const n = pages
  const coverage = RULES.map(rule => {
    const k = FAIL_RULES.includes(rule) ? obs : 0
    const unknown_reasons = {}
    if (obs - k > 0) unknown_reasons.legacy_not_instrumented = obs - k
    if (n - obs > 0) unknown_reasons.contract_limit = n - obs
    return { rule, entities: n, eligible: k, ineligible: 0, eligibility_unknown: n - k, attempted: k, not_attempted: 0,
      attempt_unknown: n - k, passed: 0, failed: k, not_applicable: 0, unknown: n - k, unknown_reasons }
  })
  const report = {
    schema_version: 4, engine_version: v2.engine_version, ruleset_version: v2.ruleset_version, request,
    started_at: v2.started_at, finished_at: v2.finished_at, outcome: 'completed', stop_reason: v2.stop_reason,
    coverage_complete: true, pages: ps, findings: evidence ? findings : [], policy_guidance: { synthetic: true },
  }
  if (evidence) {
    report.evidence_contract = {
      version: 1, policy: v2.evidence_contract.policy, comparison_key: v2.evidence_contract.comparison_key,
      observed_at: { started_at: v2.started_at, finished_at: v2.finished_at },
      observations, evaluations, coverage, truncated: n > obs, omitted_observations: n - obs,
      evaluation_coverage_complete: false,
    }
  }
  return report
}

export function buildSummary(report) {
  return JSON.stringify({
    summary_version: 5, schema_version: 4, wire_contract_version: 's14-wire-1', evidence_contract_version: report.evidence_contract ? 1 : null,
    evidence_state: 'policy_versioned', engine_version: report.engine_version, ruleset_version: report.ruleset_version,
    started_at: report.started_at, finished_at: report.finished_at, outcome: report.outcome, stop_reason: report.stop_reason,
    pages: { checked: report.pages.length }, findings: report.findings.length, synthetic: true,
  })
}

// Exact UTF-8 size: grows pages until the next one would pass the cap, then pads with
// trailing JSON whitespace (retained bytes, like the producer's exact-cap fixtures).
export function buildExactCap(opts, target = CAP) {
  const links = 14
  const probe = JSON.stringify(buildReport({ ...opts, pages: 200, links }))
  const base = JSON.stringify(buildReport({ ...opts, pages: 100, links }))
  const perPage = (Buffer.byteLength(probe) - Buffer.byteLength(base)) / 100
  let pages = Math.max(200, Math.floor((target - Buffer.byteLength(base)) / perPage) + 100)
  let raw = JSON.stringify(buildReport({ ...opts, pages, links }))
  while (Buffer.byteLength(raw) > target && pages > 200) { pages -= 10; raw = JSON.stringify(buildReport({ ...opts, pages, links })) }
  const pad = target - Buffer.byteLength(raw)
  if (pad < 0) throw new Error('could not fit target')
  return { raw: raw + ' '.repeat(pad), report: JSON.parse(raw), pages }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [out, requestId, websiteId, generation, target] = process.argv.slice(2)
  const { raw, report, pages } = buildExactCap({ requestId, websiteId, generation: Number(generation || 1) }, Number(target || CAP))
  writeFileSync(`${out}/report.json`, raw)
  writeFileSync(`${out}/summary.json`, buildSummary(report))
  console.error(`pages=${pages} bytes=${Buffer.byteLength(raw)} evaluations=${report.evidence_contract.evaluations.length} observations=${report.evidence_contract.observations.length}`)
}
