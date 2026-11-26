// Offline validator for the 1.4.0 additive amendment of audit-read availability.
// The frozen 1.3.0 validator (audit-read-contract.mjs) is untouched and still
// accepts only producer_unavailable. No network, credentials, shell or crawler.
import assert from 'node:assert/strict';
import { readJson } from './plugin-contract.mjs';

export const auditAvailabilityProfile = readJson(new URL('../docs/plugin-contract/v1.4/audit-read-availability.json', import.meta.url));

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const count = v => Number.isInteger(v) && v >= 0;
const instantOrNull = v => v === null || (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)));
const keys = (v, names, message) => assert.deepEqual(Object.keys(v).sort(), [...names].sort(), message);

export function auditAvailabilityCodes(operationId) {
  const codes = auditAvailabilityProfile.availability.codes[operationId];
  assert.ok(codes, 'unknown audit read operation: ' + operationId);
  return codes;
}

// Validates `availability` and `producer` of one successful read result.
export function validateAuditAvailability(operationId, result) {
  const codes = auditAvailabilityCodes(operationId);
  assert.ok(isObject(result), 'result object');
  assert.ok(codes.includes(result.availability), 'availability code not allowed for ' + operationId + ': ' + result.availability);
  const p = result.producer;
  assert.ok(isObject(p), 'producer object required');
  if (operationId === 'htp.website_operational_episodes') {
    keys(p, ['operations_enabled'], 'episodes producer fields');
    assert.equal(typeof p.operations_enabled, 'boolean', 'operations_enabled boolean');
    assert.equal(result.availability === 'producer_active', p.operations_enabled, 'episodes availability must follow operations_enabled');
    return;
  }
  keys(p, ['processing_enabled', 'enqueue_enabled', 'last_run_at', 'last_success_at', 'last_outcome', 'pending', 'held', 'held_by_reason', 'counts_capped'], 'events producer fields');
  assert.equal(typeof p.processing_enabled, 'boolean', 'processing_enabled boolean');
  assert.equal(typeof p.enqueue_enabled, 'boolean', 'enqueue_enabled boolean');
  assert.ok(instantOrNull(p.last_run_at), 'last_run_at instant or null');
  assert.ok(instantOrNull(p.last_success_at), 'last_success_at instant or null');
  assert.ok(p.last_outcome === null || ['success', 'retry'].includes(p.last_outcome), 'last_outcome success|retry|null');
  assert.ok(count(p.pending), 'pending integer >= 0');
  assert.ok(count(p.held), 'held integer >= 0');
  assert.ok(isObject(p.held_by_reason) && Object.values(p.held_by_reason).every(count), 'held_by_reason counts');
  assert.equal(typeof p.counts_capped, 'boolean', 'counts_capped boolean');
  const running = p.processing_enabled && p.enqueue_enabled;
  switch (result.availability) {
    case 'producer_unavailable': assert.equal(p.processing_enabled, false, 'unavailable requires processing off'); break;
    case 'producer_not_enqueuing': assert.ok(p.processing_enabled && !p.enqueue_enabled, 'not_enqueuing requires processing on and enqueue off'); break;
    case 'producer_starting': assert.ok(running && p.last_run_at === null, 'starting requires enabled gates and no run'); break;
    case 'producer_stale': case 'producer_degraded': assert.ok(running && p.last_run_at !== null, result.availability + ' requires enabled gates and a run'); break;
    case 'producer_active':
      assert.ok(running && p.last_run_at !== null, 'active requires enabled gates and a run');
      assert.notEqual(p.last_outcome, 'retry', 'active cannot follow a retry run');
      assert.ok(!(p.held_by_reason.processor_unavailable > 0), 'active cannot have processor_unavailable holds');
      break;
  }
}

// Only producer_active allows reading an empty page as "no events".
export const emptyHistoryMeansNone = result => isObject(result) && result.availability === auditAvailabilityProfile.availability.emptyMeansNoEventsValue;

const at = '2026-11-26T12:00:00Z';
const base = { processing_enabled: true, enqueue_enabled: true, last_run_at: at, last_success_at: at, last_outcome: 'success', pending: 0, held: 0, held_by_reason: {}, counts_capped: false };
const cases = {
  producer_unavailable: { ...base, processing_enabled: false, enqueue_enabled: false, last_run_at: null, last_success_at: null, last_outcome: null },
  producer_not_enqueuing: { ...base, enqueue_enabled: false },
  producer_starting: { ...base, last_run_at: null, last_success_at: null, last_outcome: null },
  producer_stale: { ...base, last_run_at: '2026-11-26T11:00:00Z' },
  producer_degraded: { ...base, last_outcome: 'retry', pending: 2 },
  producer_active: base,
};
export function syntheticAuditAvailabilityResults() {
  const events = Object.entries(cases).map(([availability, producer]) => ({ semantics_version: 1, events: [], has_more: false, next_cursor: null, availability, producer: structuredClone(producer) }));
  const episodes = ['producer_unavailable', 'producer_active'].map(availability => ({ version: 1, episodes: [], has_more: false, next_cursor: null, availability, producer: { operations_enabled: availability === 'producer_active' } }));
  return { events, episodes };
}
