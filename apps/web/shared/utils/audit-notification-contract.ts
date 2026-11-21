/** Candidate classifier only: no persistence or notification delivery. Callers must verify immutable worker receipts and scope. */
export const AUDIT_EVENT_SEMANTICS = 1 as const
export type TechnicalSeverity = 'warning' | 'alert' | 'critical'
export interface EventObservation {
  website_id: string; fqdn: string; binding_generation: number; delivery_id: string; scan_at: string; ingestion_source: 'worker' | 'import'
  schema_version: number; evidence_contract_version: number; policy_digest: string; engine_version: string; ruleset_version: string
  entity_id: string; rule: string; rule_version: string; validator_version: string
  eligibility: 'eligible' | 'ineligible' | 'unknown'; attempt: 'completed' | 'not_attempted' | 'unknown'; outcome: 'pass' | 'fail' | 'not_applicable' | 'unknown'
  severity: TechnicalSeverity | null; source_locator: string
}
export interface AuditEventCandidate {
  semantics_version: typeof AUDIT_EVENT_SEMANTICS; kind: 'new' | 'reopened' | 'severity_increased'
  website_id: string; delivery_id: string; baseline_id: string; entity_id: string; rule: string; source_locator: string
  severity: TechnicalSeverity; deduplication_key: string
}
const rank: Record<TechnicalSeverity, number> = { warning: 1, alert: 2, critical: 3 }
const scope = ['website_id', 'fqdn', 'binding_generation', 'schema_version', 'evidence_contract_version', 'policy_digest', 'engine_version', 'ruleset_version', 'entity_id', 'rule', 'rule_version', 'validator_version'] as const
function valid(o: EventObservation): boolean {
  return o.ingestion_source === 'worker' && o.schema_version === 2 && o.evidence_contract_version === 1
    && scope.every(k => o[k] !== '' && o[k] !== null && o[k] !== undefined)
    && !!o.delivery_id && !!o.source_locator && Number.isFinite(Date.parse(o.scan_at))
    && o.eligibility === 'eligible' && o.attempt === 'completed' && (o.outcome === 'pass' || o.outcome === 'fail')
}
function comparable(a: EventObservation, b: EventObservation): boolean {
  return valid(a) && valid(b) && scope.every(k => a[k] === b[k])
    && a.delivery_id !== b.delivery_id && Date.parse(a.scan_at) < Date.parse(b.scan_at)
}
/** priorFailure must be a verified comparable fail earlier than baseline to call a transition reopened. */
export function classifyAuditEvent(baseline: EventObservation, current: EventObservation, historyComplete: boolean, priorFailure?: EventObservation): AuditEventCandidate | null {
  if (!comparable(baseline, current) || current.outcome !== 'fail' || !current.severity || !Object.hasOwn(rank, current.severity)) return null
  let kind: AuditEventCandidate['kind']
  if (baseline.outcome === 'pass') {
    if (!historyComplete || (priorFailure && (!comparable(priorFailure, baseline) || priorFailure.outcome !== 'fail'))) return null
    kind = priorFailure ? 'reopened' : 'new'
  } else if (baseline.severity && Object.hasOwn(rank, baseline.severity) && rank[current.severity] > rank[baseline.severity]) {
    kind = 'severity_increased'
  } else return null
  const deduplication_key = JSON.stringify([AUDIT_EVENT_SEMANTICS, current.website_id, current.delivery_id, current.entity_id, current.rule, kind])
  return { semantics_version: AUDIT_EVENT_SEMANTICS, kind, website_id: current.website_id, delivery_id: current.delivery_id, baseline_id: baseline.delivery_id, entity_id: current.entity_id, rule: current.rule, source_locator: current.source_locator, severity: current.severity, deduplication_key }
}
