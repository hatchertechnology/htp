import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { findingConfidence, findingEvaluation, findingPriority } from '../shared/utils/seosmith-remediation'
import type { AuditDetail, AuditEvaluation, AuditReport, AuditSummary } from '../shared/types/seosmith'

const evaluation = {
  finding_key: 'a', source_locator: '/findings/0', outcome: 'fail', confidence: 'high',
  rule: 'missing_title', rule_version: '2026-11-01.1', validator_version: 's01-1',
} as AuditEvaluation

it('attributes confidence only to the unique evaluation for the exact finding and supported provenance', () => {
  const report = { request: {}, pages: [], findings: [{ key: 'a' }, { key: 'a' }] } as unknown as AuditReport
  expect(findingEvaluation(report, 0)).toBeUndefined()
  report.evidence_contract = { evaluations: [evaluation] } as AuditReport['evidence_contract']
  expect(findingEvaluation(report, 0)).toBeUndefined()
  report.evidence_contract = { version: 1, evaluations: [evaluation] } as AuditReport['evidence_contract']
  expect(findingEvaluation(report, 0)).toBe(evaluation)
  expect(findingEvaluation(report, 1)).toBeUndefined()
  report.evidence_contract.evaluations.push(evaluation)
  expect(findingEvaluation(report, 0)).toBeUndefined()
})

it('certifies confidence only for exact high confidence with complete provenance', () => {
  const report = baseReport({
    schema_version: 2,
    evidence_contract: { version: 1, evaluations: [{ ...evaluation }] } as AuditReport['evidence_contract'],
  })
  expect(findingConfidence(report, 0)).toBe('high')
  for (const confidence of ['unknown', 'low', undefined, null]) {
    report.evidence_contract!.evaluations = [{ ...evaluation, confidence } as unknown as AuditEvaluation]
    expect(findingConfidence(report, 0)).toBeUndefined()
    const priority = findingPriority(detail(report), 0)
    expect(priority.inputs.find(input => input.key === 'confidence')).toMatchObject({ state: 'unknown', value: null })
  }
  report.evidence_contract!.evaluations = [{ ...evaluation, rule_version: '' }]
  expect(findingConfidence(report, 0)).toBeUndefined()
  expect(findingPriority(detail(report), 0).inputs.find(input => input.key === 'confidence')).toMatchObject({ state: 'unknown', value: null })
})

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    schema_version: 1,
    request: { url: 'https://example.com/', max_pages: 10, check_external_links: false },
    pages: [],
    findings: [{ key: 'a', rule: 'missing_title', severity: 'warning', url: 'https://example.com/', evidence: 'missing' }],
    coverage_complete: true,
    ...overrides,
  } as unknown as AuditReport
}

function detail(report: AuditReport, summary: Partial<AuditSummary> = {}): AuditDetail {
  return {
    delivery_id: 'run', scan_at: '2026-11-24T00:00:00Z', received_at: '2026-11-24T00:00:00Z', ingestion_source: 'import',
    summary: {
      schema_version: report.schema_version ?? 1,
      outcome: report.outcome ?? 'completed',
      coverage_complete: true,
      ...summary,
    } as AuditSummary,
    report,
  }
}

it('reports schema 1 priority from the complete receiver-derived crawl coverage on the saved summary', () => {
  const priority = findingPriority(detail(baseReport(), { coverage_complete: true }), 0)
  expect(priority.version).toBe('h04-priority-1')
  expect(priority.inputs.map(input => [input.key, input.state, input.value])).toEqual([
    ['severity', 'known', 'warning'],
    ['confidence', 'unknown', null],
    ['reach', 'known', '1'],
    ['policy', 'unavailable', null],
  ])
  expect(priority.inputs[2]!.basis).toMatch(/receiver summary reports complete crawl coverage/)
  expect(priority.inputs[2]!.basis).toMatch(/not a website-wide total/)
  expect(priority.rationale).toMatch(/No predicted revenue/)
  expect(priority.rationale).toMatch(/do not verify a fix/i)
})

it('keeps reach a lower bound when the receiver-derived summary says coverage is incomplete', () => {
  const report = baseReport({
    findings: [
      { key: 'a', rule: 'missing_title', severity: 'warning', url: 'https://example.com/', evidence: 'missing' },
      { key: 'b', rule: 'missing_title', severity: 'warning', url: 'https://example.com/about', evidence: 'missing' },
    ],
    coverage_complete: false,
  } as unknown as Partial<AuditReport>)
  const priority = findingPriority(detail(report, { coverage_complete: false }), 0)
  const reach = priority.inputs.find(input => input.key === 'reach')!
  expect(reach.state).toBe('unknown')
  expect(reach.value).toBeNull()
  expect(reach.basis).toMatch(/2 distinct observed saved URL/)
  expect(reach.basis).toMatch(/crawl coverage incomplete/)
  expect(reach.basis).toMatch(/lower bound/)
  expect(reach.basis).toMatch(/website-wide reach is unknown/)
})

it('does not trust a raw legacy complete claim when the saved summary is incomplete', () => {
  // This is the accepted PR75 fixture shape: report.coverage_complete is true,
  // but the receiver-derived summary reports incomplete crawl coverage.
  const report = baseReport({ coverage_complete: true })
  const priority = findingPriority(detail(report, { coverage_complete: false }), 0)
  const reach = priority.inputs.find(input => input.key === 'reach')!
  expect(report.coverage_complete).toBe(true)
  expect(reach).toMatchObject({ state: 'unknown', value: null })
  expect(reach.basis).toMatch(/saved receiver summary reports crawl coverage incomplete/)
  expect(reach.basis).not.toMatch(/complete crawl coverage/)
})

it('attributes confidence and complete versioned reach from the saved summary without using raw contract coverage', () => {
  const report = baseReport({
    schema_version: 2,
    coverage_complete: true,
    findings: [
      { key: 'a', rule: 'missing_title', severity: 'warning', url: 'https://example.com/', evidence: 'missing' },
      { key: 'b', rule: 'broken_resource', severity: 'critical', url: 'https://example.com/', evidence: 'broken' },
    ],
    evidence_contract: {
      version: 1,
      evaluation_coverage_complete: true,
      truncated: false,
      policy: { canonical_json: '{"policy_version":"s01-1","ruleset_version":"2026-11-01.1"}', signature: 'sha256:abcd' },
      evaluations: [{ ...evaluation }],
    },
  } as unknown as Partial<AuditReport>)
  const priority = findingPriority(detail(report, {
    schema_version: 2,
    coverage_complete: true,
    crawl_coverage_complete: true,
    evaluation_coverage_complete: true,
  }), 0)
  expect(priority.inputs.find(input => input.key === 'confidence')).toMatchObject({ state: 'known', value: 'high' })
  expect(priority.inputs.find(input => input.key === 'reach')).toMatchObject({ state: 'known', value: '1' })
  expect(priority.inputs.find(input => input.key === 'reach')!.basis).toMatch(/complete crawl and evaluation coverage/)
  const policy = priority.inputs.find(input => input.key === 'policy')!
  expect(policy.state).toBe('unavailable')
  expect(policy.basis).toMatch(/collection policy/)
  expect(policy.basis).toMatch(/Intended policy needs H02\/S14/)
})

it('does not use a raw v2 contract evaluation claim when the saved summary evaluation coverage is incomplete', () => {
  const report = baseReport({
    schema_version: 2,
    evidence_contract: {
      version: 1,
      evaluation_coverage_complete: true,
      truncated: false,
      evaluations: [{ ...evaluation }],
    },
  } as unknown as Partial<AuditReport>)
  const priority = findingPriority(detail(report, {
    schema_version: 2,
    coverage_complete: false,
    crawl_coverage_complete: true,
    evaluation_coverage_complete: false,
  }), 0)
  const reach = priority.inputs.find(input => input.key === 'reach')!
  expect(reach).toMatchObject({ state: 'unknown', value: null })
  expect(reach.basis).toMatch(/crawl coverage complete and evaluation coverage incomplete/)
})

it('counts distinct valid observed saved URLs and stays unknown for invalid or missing URLs', () => {
  const report = baseReport({
    findings: [
      { key: 'a', rule: 'missing_title', severity: 'warning', url: 'https://example.com/', evidence: 'missing' },
      { key: 'b', rule: 'missing_title', severity: 'warning', url: 'https://example.com', evidence: 'duplicate' },
      { key: 'c', rule: 'missing_title', severity: 'warning', url: 'https://example.com/about', evidence: 'missing' },
      { key: 'd', rule: 'missing_title', severity: 'warning', url: 'not a url', evidence: 'invalid' },
      { key: 'e', rule: 'missing_title', severity: 'warning' } as unknown as AuditReport['findings'][number],
    ],
  } as unknown as Partial<AuditReport>)
  const priority = findingPriority(detail(report, { coverage_complete: true }), 0)
  const reach = priority.inputs.find(input => input.key === 'reach')!
  expect(reach).toMatchObject({ state: 'unknown', value: null })
  expect(reach.basis).toMatch(/2 distinct observed saved URL/)
  expect(reach.basis).toMatch(/2 matching saved finding\(s\) have an invalid or missing URL/)
  expect(reach.basis).toMatch(/lower bound only/)
})

it('does not turn an ambiguous or unknown-confidence evaluation into a confident priority', () => {
  const report = baseReport({
    schema_version: 2,
    coverage_complete: false,
    evidence_contract: {
      version: 1,
      evaluation_coverage_complete: false,
      truncated: true,
      evaluations: [
        { ...evaluation, confidence: 'unknown' },
        { ...evaluation, confidence: 'unknown' },
      ],
    },
  } as unknown as Partial<AuditReport>)
  const priority = findingPriority(detail(report, {
    schema_version: 2,
    coverage_complete: false,
    crawl_coverage_complete: false,
    evaluation_coverage_complete: false,
  }), 0)
  expect(priority.inputs.find(input => input.key === 'confidence')).toMatchObject({ state: 'unknown', value: null })
  expect(priority.inputs.find(input => input.key === 'reach')!.state).toBe('unknown')
})

it('uses the checked-in saved schema 2 fixture without fabricating a reach or policy', () => {
  const raw = readFileSync(new URL('../../../supabase/tests/fixtures/contracts/v2-partial.json', import.meta.url), 'utf8')
  const report = JSON.parse(raw) as AuditReport
  const priority = findingPriority(detail(report, {
    schema_version: 2,
    outcome: report.outcome,
    coverage_complete: false,
    crawl_coverage_complete: false,
    evaluation_coverage_complete: false,
  }), 0)
  expect(priority.inputs.find(input => input.key === 'severity')!.state).toBe('known')
  expect(priority.inputs.find(input => input.key === 'reach')).toMatchObject({ state: 'unknown', value: null })
  expect(priority.inputs.find(input => input.key === 'policy')).toMatchObject({ state: 'unavailable', value: null })
  expect(priority.rationale).not.toMatch(/revenue (of|uplift of)|predicted revenue (of|\$)/i)
})

it('uses the checked-in legacy fixture with its receiver-derived complete summary', () => {
  const raw = readFileSync(new URL('../../../supabase/tests/fixtures/seosmith-expanded.json', import.meta.url), 'utf8')
  const report = JSON.parse(raw) as AuditReport
  const priority = findingPriority(detail(report, { coverage_complete: true }), 0)
  expect(priority.inputs.find(input => input.key === 'confidence')!.state).toBe('unknown')
  expect(priority.inputs.find(input => input.key === 'reach')).toMatchObject({ state: 'known', value: '1' })
})
