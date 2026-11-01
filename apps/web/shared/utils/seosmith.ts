import type { AuditRun, AuditFinding, AuditPage } from '../types/seosmith'
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
// These rules require observing another URL. Source-only rules (titles, rel
// attributes, mixed content, etc.) can still be compared for an observed page.
const targetRules = new Set([
  'broken_internal_link', 'external_link_broken', 'external_link_redirect', 'nofollow_indexable',
  'broken_resource', 'canonical_to_error', 'canonical_to_redirect', 'canonical_to_noindex',
  'canonical_chain', 'hreflang_to_error', 'hreflang_to_redirect', 'hreflang_to_noindex',
  'hreflang_noncanonical', 'hreflang_return_missing', 'redirect_chain', 'redirect_loop',
])
const navigationTargetRules = new Set(['broken_internal_link', 'external_link_broken', 'external_link_redirect', 'nofollow_indexable'])
function observed(page: AuditPage | undefined): boolean {
  return !!page && page.status !== null && page.status >= 100 && page.status < 600
    && !page.error && !page.blocked_by_robots && !page.extraction_truncated
    && !page.flags?.some(flag => ['extraction_limit', 'legacy_checkpoint_metadata'].includes(flag))
}
function canResolve(finding: AuditFinding, pages: Map<string, AuditPage>): boolean {
  const source = pages.get(finding.url)
  if (!observed(source)) return false
  if (!targetRules.has(finding.rule)) return true
  if (finding.rule === 'redirect_chain' || finding.rule === 'redirect_loop') {
    const visited = new Set<string>()
    let page = source
    while (page && !visited.has(page.url)) {
      visited.add(page.url)
      const target = page.redirect || page.refresh_target
      if (!target) break
      page = pages.get(target)
      if (!observed(page)) return false
    }
  }
  const targets = finding.evidence_items?.length ? finding.evidence_items : [finding.evidence]
  // Historical findings may lack target evidence. Absence is not proof of a fix.
  return targets.length > 0 && targets.every(target => {
    if (!safeAuditUrl(target)) return false
    if (observed(pages.get(target))) return true
    // Removing the edge is conclusive from complete source extraction, without
    // needing to fetch its former target. Missing extraction arrays are unknown.
    return navigationTargetRules.has(finding.rule) && !!source?.links && !!source.relationships
      && !source.links.some(link => link.url === target)
      && !source.relationships.some(relation => relation.kind === 'navigation' && relation.url === target)
  })
}
export function findingChanges(current: AuditRun, previous: AuditRun, now: AuditFinding[], before: AuditFinding[], currentPages: AuditPage[]) {
  if (!comparable(current, previous)) return null
  const key = (f: AuditFinding) => `${f.rule}\n${f.url}`
  const currentKeys = new Set(now.map(key)), previousKeys = new Set(before.map(key))
  const pages = new Map(currentPages.map(page => [page.url, page]))
  // Group distinct evidence instances under the collector's rule/page identity.
  // Every prior instance needs evidence before the group can be called resolved.
  const missing = new Map<string, AuditFinding[]>()
  for (const finding of before) {
    const id = key(finding)
    if (!currentKeys.has(id)) {
      const group = missing.get(id)
      if (group) group.push(finding)
      else missing.set(id, [finding])
    }
  }
  const resolved = [...missing.values()].filter(findings => findings.every(finding => canResolve(finding, pages))).length
  return {
    added: [...currentKeys].filter(k => !previousKeys.has(k)).length,
    resolved,
    persistent: [...currentKeys].filter(k => previousKeys.has(k)).length,
    unverified: missing.size - resolved,
  }
}
export function safeAuditUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
