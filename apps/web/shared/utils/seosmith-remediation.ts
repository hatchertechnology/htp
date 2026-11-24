import type { AuditEvaluation, AuditReport } from '../types/seosmith'

/** Only the unique explicit failed evaluation for this exact saved finding is attributed. */
export function findingEvaluation(report: AuditReport, index: number): AuditEvaluation | undefined {
  const finding = report.findings[index]
  if (!finding) return undefined
  if ((report.evidence_contract?.version != null && report.evidence_contract.version !== 1) || !Array.isArray(report.evidence_contract?.evaluations)) return undefined
  const matches = report.evidence_contract.evaluations.filter(item =>
    item.finding_key === finding.key && item.source_locator === `/findings/${index}` && item.outcome === 'fail') ?? []
  return matches.length === 1 ? matches[0] : undefined
}
