import { expect, it } from 'vitest'
import { findingEvaluation } from '../shared/utils/seosmith-remediation'
import type { AuditEvaluation, AuditReport } from '../shared/types/seosmith'
const report = { request: {}, pages: [], findings: [{ key: 'a' }, { key: 'a' }] } as unknown as AuditReport
const evaluation = { finding_key: 'a', source_locator: '/findings/0', outcome: 'fail', confidence: 'high' } as AuditEvaluation
it('attributes confidence only to the unique evaluation for the exact finding', () => {
  expect(findingEvaluation(report, 0)).toBeUndefined()
  report.evidence_contract = { evaluations: [evaluation] } as AuditReport['evidence_contract']
  expect(findingEvaluation(report, 0)).toBe(evaluation)
  expect(findingEvaluation(report, 1)).toBeUndefined()
  report.evidence_contract!.evaluations.push(evaluation)
  expect(findingEvaluation(report, 0)).toBeUndefined()
})
