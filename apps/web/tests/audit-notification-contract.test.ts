import { expect, it } from 'vitest'
import { classifyAuditEvent, type EventObservation } from '../shared/utils/audit-notification-contract'
const observation = (delivery_id: string, scan_at: string, outcome: EventObservation['outcome']): EventObservation => ({ website_id:'site', fqdn:'example.com', binding_generation:1, delivery_id, scan_at, ingestion_source:'worker', schema_version:2, evidence_contract_version:1, policy_digest:'digest', engine_version:'engine', ruleset_version:'rules', entity_id:'entity', rule:'title', rule_version:'1', validator_version:'1', eligibility:'eligible', attempt:'completed', outcome, severity: outcome === 'fail' ? 'warning' : null, source_locator:'/evaluations/0' })
const old = observation('old','2026-11-01T00:00:00Z','pass')
const now = observation('now','2026-11-02T00:00:00Z','fail')
it('classifies evidenced transitions and severity escalation', () => {
  expect(classifyAuditEvent(old, now, true)?.kind).toBe('new')
  expect(classifyAuditEvent(old, now, false)).toBeNull()
  const prior = observation('prior','2026-10-31T00:00:00Z','fail')
  expect(classifyAuditEvent(old, now, true, prior)?.kind).toBe('reopened')
  expect(classifyAuditEvent(old, now, true, {...prior, policy_digest:'other'})).toBeNull()
  expect(classifyAuditEvent({...old,outcome:'fail',severity:'warning'}, {...now,severity:'critical'}, true)?.kind).toBe('severity_increased')
  expect(classifyAuditEvent({...old,outcome:'fail',severity:'warning'}, now, true)).toBeNull()
  expect(classifyAuditEvent(old, now, true)?.deduplication_key).toBe(classifyAuditEvent(old, now, true)?.deduplication_key)
})
it('suppresses unknown, incomparable, imported and out-of-order evidence', () => {
  for (const change of [{outcome:'unknown'}, {attempt:'not_attempted'}, {eligibility:'unknown'}, {policy_digest:'different'}, {rule_version:'different'}, {binding_generation:2}, {ingestion_source:'import'}, {scan_at:old.scan_at}, {severity:null}]) expect(classifyAuditEvent(old, {...now,...change} as EventObservation, true)).toBeNull()
  expect(classifyAuditEvent({...old,outcome:'unknown'}, now, true)).toBeNull()
  expect(classifyAuditEvent(old, {...now,outcome:'pass'}, true)).toBeNull()
})
