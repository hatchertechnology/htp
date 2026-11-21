import type { AuditDetail, AuditEvaluation, AuditFinding, AuditPage } from '../types/seosmith'

/** Version 1 is a read-time interpretation of retained S01 evidence, not a new producer contract. */
export type LifecycleState = 'new' | 'persisting' | 'changed' | 'resolved' | 'reopened' | 'not_observed'
export interface LifecycleEntry {
  entity_id: string; rule: string; state: LifecycleState
  first_observed: string; last_observed: string
  finding: AuditFinding | null; source_delivery_id: string; source_locator: string
}
export interface LifecycleComparison {
  version: 1; baseline_id: string; current_id: string; entries: LifecycleEntry[]
  coverage: { rule: string; entities: number; attempted: number; unknown: number; excluded: number }[]
  urls: UrlChange[]
}

function compatible(a: AuditDetail, b: AuditDetail): boolean {
  const x = a.report.evidence_contract, y = b.report.evidence_contract
  return a.summary.schema_version === 2 && b.summary.schema_version === 2 && x?.version === 1 && y?.version === 1
    && !!a.summary.engine_version && a.summary.engine_version === b.summary.engine_version
    && !!a.summary.ruleset_version && a.summary.ruleset_version === b.summary.ruleset_version
    && !!a.summary.comparison_key && a.summary.comparison_key === b.summary.comparison_key
    && x.comparison_key === y.comparison_key && x.policy.signature === y.policy.signature
}
const identity = (e: AuditEvaluation) => JSON.stringify([e.entity_id, e.rule])
function findings(report: AuditDetail): Map<string, AuditFinding> {
  return new Map(report.report.findings.map(f => [f.key, f]))
}
function detail(f: AuditFinding | undefined): string {
  // Stable ordering prevents object key ordering from appearing as a change.
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v
  return JSON.stringify(canonical(f && { severity: f.severity, evidence: f.evidence, evidence_items: f.evidence_items, details: f.details }))
}
function evaluated(e: AuditEvaluation | undefined): boolean {
  return !!e && e.eligibility === 'eligible' && e.attempt === 'completed' && (e.outcome === 'pass' || e.outcome === 'fail')
}

/** Input is ordered oldest to newest and must be a contiguous, explicitly selected history. */
export function lifecycleHistory(runs: AuditDetail[], baselineId?: string): LifecycleComparison | null {
  if (runs.length < 2 || new Set(runs.map(r => r.delivery_id)).size !== runs.length || !runs.every((r, i) => Number.isFinite(Date.parse(r.scan_at)) && (i === 0 || (compatible(runs[0]!, r) && Date.parse(r.scan_at) >= Date.parse(runs[i - 1]!.scan_at))))) return null
  const current = runs[runs.length - 1]!, baseline = baselineId ? runs.slice(0, -1).find(r => r.delivery_id === baselineId) : runs[runs.length - 2]
  if (!baseline) return null
  const previous = new Map(baseline.report.evidence_contract!.evaluations.map(e => [identity(e), e]))
  const latest = new Map(current.report.evidence_contract!.evaluations.map(e => [identity(e), e]))
  const beforeFindings = findings(baseline), nowFindings = findings(current)
  const keys = new Set(runs.flatMap(r => r.report.evidence_contract!.evaluations.filter(e => e.outcome === 'fail').map(identity)))
  const entries: LifecycleEntry[] = []
  for (const key of keys) {
    const before = previous.get(key), now = latest.get(key)
    const lastFailureRun = [...runs].reverse().find(r => r.report.evidence_contract!.evaluations.some(e => identity(e) === key && e.outcome === 'fail'))!
    const lastFailure = lastFailureRun.report.evidence_contract!.evaluations.find(e => identity(e) === key && e.outcome === 'fail')!
    const sample = now ?? before ?? lastFailure
    const b = before?.finding_key ? beforeFindings.get(before.finding_key) : undefined
    const n = now?.finding_key ? nowFindings.get(now.finding_key) : undefined
    let state: LifecycleState = 'not_observed'
    if (evaluated(before) && evaluated(now) && before!.rule_version === now!.rule_version && before!.validator_version === now!.validator_version) {
      if (before!.outcome === 'fail' && now!.outcome === 'pass') state = 'resolved'
      else if (before!.outcome === 'fail' && now!.outcome === 'fail') state = detail(b) === detail(n) ? 'persisting' : 'changed'
      else if (before!.outcome === 'pass' && now!.outcome === 'pass' && runs.slice(0, runs.indexOf(baseline)).some(r => r.report.evidence_contract!.evaluations.some(e => identity(e) === key && evaluated(e) && e.outcome === 'fail' && e.rule_version === now!.rule_version && e.validator_version === now!.validator_version))) state = 'resolved'
      else if (before!.outcome === 'pass' && now!.outcome === 'fail') {
        // A prior failure followed by an explicit pass is a reopening, not merely a new issue.
        state = runs.slice(0, runs.indexOf(baseline)).some(r => r.report.evidence_contract!.evaluations.some(e => identity(e) === key && evaluated(e) && e.outcome === 'fail' && e.rule_version === now!.rule_version && e.validator_version === now!.validator_version)) ? 'reopened' : 'new'
      }
    }
    const observed = runs.filter(r => r.report.evidence_contract!.evaluations.some(e => identity(e) === key && evaluated(e) && e.outcome === 'fail'))
    const evidence = now?.outcome === 'fail' ? now : before?.outcome === 'fail' ? before : lastFailure
    const source = now?.outcome === 'fail' ? current : before?.outcome === 'fail' ? baseline : lastFailureRun
    const storedFinding = evidence.finding_key ? findings(source).get(evidence.finding_key) : undefined
    entries.push({ entity_id: sample.entity_id, rule: sample.rule, state, first_observed: observed[0]?.scan_at ?? source.scan_at, last_observed: observed[observed.length - 1]?.scan_at ?? source.scan_at, finding: storedFinding ?? null, source_delivery_id: source.delivery_id, source_locator: evidence.source_locator })
  }
  const coverage = current.report.evidence_contract!.coverage.map(c => ({ rule: c.rule, entities: c.entities, attempted: c.attempted, unknown: c.unknown, excluded: c.ineligible + c.eligibility_unknown }))
  return { version: 1, baseline_id: baseline.delivery_id, current_id: current.delivery_id, entries, coverage, urls: compareUrls(baseline, current) }
}

/** Only compare properties that exist in both available source observations. */
export function urlPropertyChanges(before: AuditPage, current: AuditPage): { property: string; before: unknown; current: unknown }[] {
  if (before.url !== current.url || !!before.is_resource !== !!current.is_resource || before.error || current.error || before.blocked_by_robots || current.blocked_by_robots || before.status == null || current.status == null || before.extraction_truncated || current.extraction_truncated) return []
  const fields: (keyof AuditPage)[] = ['status', 'content_type', 'redirect']
  const html = (p: AuditPage) => p.status != null && p.status >= 200 && p.status < 300 && !p.is_resource && ['text/html', 'application/xhtml+xml', 'application/vnd.wap.xhtml+xml'].includes(p.content_type?.split(';', 1)[0]?.trim().toLowerCase() ?? '')
  if (html(before) && html(current)) fields.push('title', 'description', 'canonical', 'header_canonical', 'robots', 'language', 'body_hash', 'links', 'relationships', 'alternates')
  return fields.filter(k => before[k] !== undefined && current[k] !== undefined && JSON.stringify(before[k]) !== JSON.stringify(current[k])).map(property => ({ property, before: before[property], current: current[property] }))
}

export interface UrlChange {
  entity_id: string; url: string; state: 'changed' | 'not_observed'
  properties: { property: string; before: unknown; current: unknown }[]
  baseline_locator: string | null; current_locator: string | null
}
/** Only explicitly available S01 observations support a property comparison. */
export function compareUrls(baseline: AuditDetail, current: AuditDetail): UrlChange[] {
  const observations = (r: AuditDetail) => new Map(r.report.evidence_contract!.observations.map(o => [o.entity_id, o]))
  const before = observations(baseline), now = observations(current)
  const result: UrlChange[] = []
  const page = (r: AuditDetail, locator: string | undefined) => {
    const match = locator?.match(/^\/pages\/(0|[1-9][0-9]*)$/)
    return match ? r.report.pages[Number(match[1])] : undefined
  }
  for (const entity_id of new Set([...before.keys(), ...now.keys()])) {
    const b = before.get(entity_id), n = now.get(entity_id)
    const bp = page(baseline, b?.source_locator), np = page(current, n?.source_locator)
    const usable = b?.state === 'available' && n?.state === 'available' && bp && np && bp.url === np.url && !!bp.is_resource === !!np.is_resource && !bp.error && !np.error && !bp.blocked_by_robots && !np.blocked_by_robots && bp.status != null && np.status != null && !bp.extraction_truncated && !np.extraction_truncated && ![...(bp.flags ?? []), ...(np.flags ?? [])].some(f => ['extraction_limit', 'discovery_limit', 'legacy_checkpoint_metadata'].includes(f))
    if (!usable) {
      result.push({ entity_id, url: np?.url ?? bp?.url ?? entity_id, state: 'not_observed', properties: [], baseline_locator: b?.source_locator ?? null, current_locator: n?.source_locator ?? null })
      continue
    }
    const properties = urlPropertyChanges(bp, np)
    if (properties.length) result.push({ entity_id, url: np.url, state: 'changed', properties, baseline_locator: b.source_locator, current_locator: n.source_locator })
  }
  return result
}
