import type { AuditRecordCounts, AuditRuleCoverage, AuditSummary } from '../types/seosmith'

/** Saved-summary version emitted by the receiver for schema 4. */
export const SCHEMA4_SUMMARY_VERSION = 5
export const SCHEMA4_SCHEMA_VERSION = 4

/**
 * How much of the saved summary the dashboard can truthfully present.
 *
 * `legacy` summaries (schema 1/2) keep their existing panels. A schema-4
 * summary with a version we do not render stays visible only so the dashboard
 * can say explicitly that no versioned claims are supported. Absence of a
 * finding is never upgraded into a clean result.
 */
export type SemanticsSupport = 'schema4-summary5' | 'schema4-unsupported' | 'legacy' | 'none'

export function semanticsSupport(summary: AuditSummary | null | undefined): SemanticsSupport {
  if (!summary) return 'none'
  if (summary.schema_version !== SCHEMA4_SCHEMA_VERSION) return 'legacy'
  return summary.summary_version === SCHEMA4_SUMMARY_VERSION ? 'schema4-summary5' : 'schema4-unsupported'
}

export type RecordCountKind = 'observation' | 'advisory' | 'violation' | 'neutral'
export interface RecordCountRow {
  key: keyof AuditRecordCounts
  label: string
  kind: RecordCountKind
}
/** Stable order and truthful labels for receiver record counts. */
export const recordCountRows: RecordCountRow[] = [
  { key: 'observation', label: 'Observations', kind: 'observation' },
  { key: 'advisory_triggered', label: 'Advisories triggered', kind: 'advisory' },
  { key: 'advisory_not_triggered', label: 'Advisories not triggered', kind: 'advisory' },
  { key: 'violation', label: 'Policy violations', kind: 'violation' },
  { key: 'no_violation', label: 'No policy violation', kind: 'violation' },
  { key: 'not_applicable', label: 'Not applicable', kind: 'neutral' },
  { key: 'unknown', label: 'Unknown', kind: 'neutral' },
]
export function recordCounts(counts: AuditRecordCounts | undefined): Array<RecordCountRow & { count: number }> {
  return recordCountRows.map(row => ({ ...row, count: counts?.[row.key] ?? 0 }))
}

export type RuleClaim = 'verified-clean' | 'findings-observed' | 'unverified'
export const ruleClaimLabels: Record<RuleClaim, string> = {
  'verified-clean': 'Verified clean within retained scope',
  'findings-observed': 'Finding observed',
  unverified: 'Unknown — absence is not a pass',
}
export function ruleClaim(coverage: AuditRuleCoverage | undefined): RuleClaim {
  if (!coverage || coverage.coverage !== 'complete_verified') return 'unverified'
  return coverage.reported_findings > 0 ? 'findings-observed' : 'verified-clean'
}
export function labelRule(rule: string): string {
  return rule.replaceAll('_', ' ')
}

export interface SemanticsTotals {
  rules: number
  verified: number
  findings: number
  unknown: number
}
export function ruleClaimTotals(ruleCoverage: Record<string, AuditRuleCoverage> | undefined): SemanticsTotals {
  const rows = Object.values(ruleCoverage ?? {}).map(ruleClaim)
  return {
    rules: rows.length,
    verified: rows.filter(claim => claim === 'verified-clean').length,
    findings: rows.filter(claim => claim === 'findings-observed').length,
    unknown: rows.filter(claim => claim === 'unverified').length,
  }
}

/** Complete verification means the retained population was reproduced, not that the site is clean. */
export function auditCoverageLabel(audit: AuditSummary['audit_coverage']): string {
  return audit === 'complete_verified' ? 'Complete verified' : audit === 'unknown_partial' ? 'Partial or unknown' : 'Unavailable'
}
