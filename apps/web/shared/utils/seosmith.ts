import type { AuditRun, AuditFinding } from '../types/seosmith'
export type AuditMetric = 'findings' | 'critical' | 'alert' | 'warning' | 'checked' | 'http_errors' | 'rate'
export const auditMetricLabels: Record<AuditMetric, string> = { findings: 'All findings', critical: 'Critical findings', alert: 'Alerts', warning: 'Warnings', checked: 'URLs checked', http_errors: 'HTTP errors', rate: 'Findings per 100 URLs' }
export function auditValue(run: AuditRun, metric: AuditMetric): number | null {
  const s = run.summary
  const value = metric === 'findings' ? s.findings : metric === 'rate' ? (s.pages.checked ? s.findings / s.pages.checked * 100 : null) : metric === 'checked' || metric === 'http_errors' ? s.pages[metric] : s.severities[metric]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
export function comparable(a: AuditRun, b: AuditRun): boolean {
  return [a, b].every(run => run.summary.coverage_complete === true
    && run.summary.outcome === 'completed'
    && (!run.summary.stop_reason || run.summary.stop_reason === 'frontier_exhausted'))
    && !!a.summary.engine_version && a.summary.engine_version === b.summary.engine_version
    && !!a.summary.ruleset_version && a.summary.ruleset_version === b.summary.ruleset_version
    && a.summary.comparison_key === b.summary.comparison_key
}
export function auditPoints(runs: AuditRun[], metric: AuditMetric) {
  return [...runs].filter(r => !!r.summary.finished_at && Number.isFinite(Date.parse(r.summary.finished_at))).sort((a, b) => Date.parse(a.scan_at) - Date.parse(b.scan_at) || a.delivery_id.localeCompare(b.delivery_id)).map(run => ({ run, time: Date.parse(run.scan_at), value: auditValue(run, metric) }))
}
export function findingChanges(current: AuditRun, previous: AuditRun, now: AuditFinding[], before: AuditFinding[]) {
  if (!comparable(current, previous)) return null
  const key = (f: AuditFinding) => `${f.rule}\n${f.url}`
  const currentKeys = new Set(now.map(key)), previousKeys = new Set(before.map(key))
  return { added: [...currentKeys].filter(k => !previousKeys.has(k)).length, resolved: [...previousKeys].filter(k => !currentKeys.has(k)).length, persistent: [...currentKeys].filter(k => previousKeys.has(k)).length }
}
export function safeAuditUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
