import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { findingEvaluation, findingPriority } from '../shared/utils/seosmith-remediation'
import type { AuditEvaluation, AuditReport } from '../shared/types/seosmith'

const evaluation = { finding_key: 'a', source_locator: '/findings/0', outcome: 'fail', confidence: 'high' } as AuditEvaluation

it('attributes confidence only to the unique evaluation for the exact finding', () => {
  const report = { request: {}, pages: [], findings: [{ key: 'a' }, { key: 'a' }] } as unknown as AuditReport
  expect(findingEvaluation(report, 0)).toBeUndefined()
  report.evidence_contract = { evaluations: [evaluation] } as AuditReport['evidence_contract']
  expect(findingEvaluation(report, 0)).toBe(evaluation)
  expect(findingEvaluation(report, 1)).toBeUndefined()
  report.evidence_contract!.evaluations.push(evaluation)
  expect(findingEvaluation(report, 0)).toBeUndefined()
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

it('reports schema 1 priority as severity known, confidence unknown and reach known from complete coverage', () => {
  const priority = findingPriority(baseReport(), 0)
  expect(priority.version).toBe('h04-priority-1')
  expect(priority.inputs.map(input => [input.key, input.state, input.value])).toEqual([
    ['severity', 'known', 'warning'],
    ['confidence', 'unknown', null],
    ['reach', 'known', '1'],
    ['policy', 'unavailable', null],
  ])
  expect(priority.inputs[2]!.basis).toMatch(/complete coverage/)
  expect(priority.rationale).toMatch(/No predicted revenue/)
  expect(priority.rationale).toMatch(/do not verify a fix/i)
})

it('keeps reach a lower bound when coverage is incomplete and never invents a site-wide figure', () => {
  const report = baseReport({
    findings: [
      { key: 'a', rule: 'missing_title', severity: 'warning', url: 'https://example.com/', evidence: 'missing' },
      { key: 'b', rule: 'missing_title', severity: 'warning', url: 'https://example.com/about', evidence: 'missing' },
    ],
    coverage_complete: false,
  } as unknown as Partial<AuditReport>)
  const priority = findingPriority(report, 0)
  const reach = priority.inputs.find(input => input.key === 'reach')!
  expect(reach.state).toBe('unknown')
  expect(reach.value).toBeNull()
  expect(reach.basis).toMatch(/2 saved URL/)
  expect(reach.basis).toMatch(/lower bound/)
})

it('attributes confidence from the unique failed evaluation and reaches known only for complete versioned coverage', () => {
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
      evaluations: [{ ...evaluation, rule: 'missing_title', rule_version: '2026-11-01.1', validator_version: 's01-1' }],
    },
  } as unknown as Partial<AuditReport>)
  const priority = findingPriority(report, 0)
  expect(priority.inputs.find(input => input.key === 'confidence')).toMatchObject({ state: 'known', value: 'high' })
  expect(priority.inputs.find(input => input.key === 'reach')).toMatchObject({ state: 'known', value: '1' })
  const policy = priority.inputs.find(input => input.key === 'policy')!
  expect(policy.state).toBe('unavailable')
  expect(policy.basis).toMatch(/collection policy/)
  expect(policy.basis).toMatch(/Intended policy needs H02\/S14/)
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
        { ...evaluation, confidence: 'unknown', rule: 'missing_title' },
        { ...evaluation, confidence: 'unknown', rule: 'missing_title' },
      ],
    },
  } as unknown as Partial<AuditReport>)
  const priority = findingPriority(report, 0)
  expect(priority.inputs.find(input => input.key === 'confidence')).toMatchObject({ state: 'unknown', value: null })
  expect(priority.inputs.find(input => input.key === 'reach')!.state).toBe('unknown')
})

it('uses the checked-in saved schema 2 fixture without fabricating a reach or policy', () => {
  const raw = readFileSync(new URL('../../../supabase/tests/fixtures/contracts/v2-partial.json', import.meta.url), 'utf8')
  const report = JSON.parse(raw) as AuditReport
  const priority = findingPriority(report, 0)
  expect(priority.inputs.find(input => input.key === 'severity')!.state).toBe('known')
  expect(priority.inputs.find(input => input.key === 'reach')).toMatchObject({ state: 'unknown', value: null })
  expect(priority.inputs.find(input => input.key === 'policy')).toMatchObject({ state: 'unavailable', value: null })
  expect(priority.rationale).not.toMatch(/revenue (of|uplift of)|predicted revenue (of|\$)/i)
})
