import { describe, expect, it } from 'vitest'
import { lifecycleHistory } from '../shared/utils/seosmith-lifecycle'
import { urlHistoryDeltas, type UrlHistoryRow } from '../shared/utils/seosmith-url-history'
import { isSavedDetail } from '../shared/utils/saved-detail-validation'
import { findingPriority } from '../shared/utils/seosmith-remediation'
import { canCompareRuns, sameEvidenceScope } from '../shared/utils/seosmith'
import type { AuditRun, AuditDetail, AuditEvaluation, AuditReport, AuditSummary } from '../shared/types/seosmith'

// Schema 4 carries the same optional S01 evidence v1 as schema 2. These cases
// pin that the display and history gates accept 4/4 and 2/2 and still refuse
// every cross-schema pair and every other schema.

const evaluation = (outcome: 'fail' | 'pass'): AuditEvaluation => ({
  entity_id: 'entity', rule: 'missing_title', rule_version: '1', validator_version: '1', eligibility: 'eligible', attempt: 'completed',
  outcome, unknown_reason: null, source_locator: '/findings/0', finding_key: 'key', confidence: 'high',
  expected: { state: 'present' },
} as unknown as AuditEvaluation)

function run(id: string, schema: number, outcome: 'fail' | 'pass', summary: Partial<AuditSummary> = {}): AuditDetail {
  return {
    delivery_id: id, scan_at: `2026-11-${id}T00:00:00Z`, received_at: `2026-11-${id}T00:00:00Z`, ingestion_source: 'worker',
    summary: { schema_version: schema, engine_version: 'engine', ruleset_version: 'rules', comparison_key: 'digest', outcome: 'partial', ...summary },
    report: {
      schema_version: schema, pages: [], request: {},
      findings: outcome === 'fail' ? [{ key: 'key', rule: 'missing_title', url: 'https://example.com/', severity: 'warning', evidence: 'missing' }] : [],
      evidence_contract: { version: 1, comparison_key: 'digest', observed_at: { started_at: '2026-11-01T00:00:00Z', finished_at: '2026-11-01T00:01:00Z' }, policy: { signature: 'digest', canonical_json: '{}' }, evaluations: [evaluation(outcome)], observations: [], coverage: [], truncated: false, omitted_observations: 0, evaluation_coverage_complete: true },
    },
  } as unknown as AuditDetail
}

describe('lifecycle comparison', () => {
  it('compares two schema-4 runs and two schema-2 runs', () => {
    for (const schema of [2, 4]) expect(lifecycleHistory([run('01', schema, 'fail'), run('02', schema, 'pass')])!.entries[0]?.state, `schema ${schema}`).toBe('resolved')
  })
  it('never compares across schemas or for other schemas', () => {
    expect(lifecycleHistory([run('01', 2, 'fail'), run('02', 4, 'pass')])).toBeNull()
    expect(lifecycleHistory([run('01', 4, 'fail'), run('02', 2, 'pass')])).toBeNull()
    for (const schema of [1, 3, 5]) expect(lifecycleHistory([run('01', schema, 'fail'), run('02', schema, 'pass')]), `schema ${schema}`).toBeNull()
  })
  it('still requires matching comparison keys for schema 4', () => {
    const next = run('02', 4, 'pass'); next.summary.comparison_key = 'other'
    expect(lifecycleHistory([run('01', 4, 'fail'), next])).toBeNull()
  })
})

describe('url history', () => {
  const row = (date: string, schema: string, status: string): UrlHistoryRow => ({ delivery_id: date, scan_at: date, ingestion_source: 'worker', evidence_state: 'available', schema_version: schema, comparison_key: 'k', policy_digest: 'p', engine_version: 'e', ruleset_version: 'r', source_locator: '/pages/0', unknown_reason: null, property_digests: { status } })
  const old = '2026-11-01T00:00:00Z', now = '2026-11-02T00:00:00Z'
  it('reads schema-4 pairs like schema-2 pairs', () => {
    for (const schema of ['2', '4']) expect(urlHistoryDeltas([row(now, schema, 'b'), row(old, schema, 'a')])[0], schema).toMatchObject({ state: 'changed', changed: ['status'] })
  })
  it('does not compare 2 with 4 or accept other schemas', () => {
    expect(urlHistoryDeltas([row(now, '4', 'b'), row(old, '2', 'a')])[0]?.state).toBe('not_observed')
    expect(urlHistoryDeltas([row(now, '2', 'b'), row(old, '4', 'a')])[0]?.state).toBe('not_observed')
    for (const schema of ['1', '3', '5']) expect(urlHistoryDeltas([row(now, schema, 'b'), row(old, schema, 'a')])[0]?.state, schema).toBe('not_observed')
  })
})

describe('saved detail validation', () => {
  const valid = (schema: number) => ({ ...run('01', schema, 'fail'), summary: { schema_version: schema, outcome: 'partial', pages: { checked: 1, html: 1, images: 0, http_errors: 0, fetch_errors: 0 }, severities: { critical: 0, alert: 0, warning: 0 } } })
  it('checks supported evidence v1 for schema 4 as it does for schema 2', () => {
    for (const schema of [2, 4]) {
      const value = valid(schema) as unknown as Record<string, unknown> & { report: Record<string, unknown> }
      expect(isSavedDetail(value, '01'), `schema ${schema} well formed`).toBe(true)
      const broken = { ...value, report: { ...value.report, evidence_contract: { version: 1 } } }
      expect(isSavedDetail(broken, '01'), `schema ${schema} malformed evidence`).toBe(false)
    }
  })
})

describe('remediation coverage basis', () => {
  const report = (schema: number) => run('01', schema, 'fail').report as AuditReport
  const reach = (schema: number, summary: Partial<AuditSummary>) => {
    const d = { ...run('01', schema, 'fail'), summary: { schema_version: schema, outcome: 'completed', ...summary } } as unknown as AuditDetail
    d.report = report(schema)
    return findingPriority(d, 0).inputs.find(input => input.key === 'reach')!
  }
  it('uses the receiver summary for schema 4 summary version 5', () => {
    expect(reach(4, { summary_version: 5, crawl_coverage_complete: true, evaluation_coverage_complete: true }).basis).toMatch(/complete crawl and evaluation coverage/)
    expect(reach(4, { summary_version: 5, crawl_coverage_complete: true, evaluation_coverage_complete: false }).basis).toMatch(/evaluation coverage incomplete/)
  })
  it('does not read coverage from an unsupported schema-4 summary version or an unknown schema', () => {
    expect(reach(4, { summary_version: 6, crawl_coverage_complete: true, evaluation_coverage_complete: true }).basis).toMatch(/no crawl or evaluation coverage decision/)
    expect(reach(3, { crawl_coverage_complete: true, evaluation_coverage_complete: true }).basis).toMatch(/no crawl or evaluation coverage decision/)
  })
})

describe('dashboard comparison gates (pure predicates the component calls)', () => {
  const asRun = (d: AuditDetail) => ({ ...d, summary: { ...d.summary, outcome: 'completed', coverage_complete: true, evaluation_coverage_complete: true } }) as unknown as AuditRun
  const a4 = asRun(run('02', 4, 'pass')), b4 = asRun(run('01', 4, 'fail'))
  const a2 = asRun(run('02', 2, 'pass')), b2 = asRun(run('01', 2, 'fail'))
  it('compares 4/4 and 2/2 and refuses 2/4 in both directions', () => {
    expect(canCompareRuns(a4, b4)).toBe(true)
    expect(canCompareRuns(a2, b2)).toBe(true)
    expect(canCompareRuns(a4, b2)).toBe(false)
    expect(canCompareRuns(a2, b4)).toBe(false)
  })
  it('refuses other schemas and mismatched scope', () => {
    for (const schema of [3, 5]) expect(canCompareRuns(asRun(run('02', schema, 'pass')), asRun(run('01', schema, 'pass')))).toBe(false)
    expect(canCompareRuns(a4, null)).toBe(false)
    expect(sameEvidenceScope(a4, { ...b4, summary: { ...b4.summary, comparison_key: 'other' } } as AuditRun)).toBe(false)
    expect(sameEvidenceScope(a4, { ...b4, summary: { ...b4.summary, engine_version: 'e2' } } as AuditRun)).toBe(false)
    expect(sameEvidenceScope(a4, { ...b4, summary: { ...b4.summary, ruleset_version: 'r2' } } as AuditRun)).toBe(false)
  })
  it('history walk scope stops at a schema change', () => {
    const history = [a4, asRun(run('00', 2, 'pass')), asRun(run('09', 4, 'pass'))]
    const taken: AuditRun[] = []
    for (const r of history.slice(1)) { if (!sameEvidenceScope(r, a4)) break; taken.push(r) }
    expect(taken).toEqual([])
  })
})
