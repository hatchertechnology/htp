import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditReadFixtures, syntheticAuditReadResults, validateAuditReadResults } from './audit-read-contract.mjs';
import { auditAvailabilityProfile, emptyHistoryMeansNone, syntheticAuditAvailabilityResults, validateAuditAvailability } from './audit-read-availability.mjs';

const EVENTS = 'htp.website_audit_events';
const EPISODES = 'htp.website_operational_episodes';
const results = () => syntheticAuditAvailabilityResults();
const pick = (list, code) => structuredClone(list.find(r => r.availability === code));

test('every defined code validates with its producer object', () => {
  const { events, episodes } = results();
  assert.deepEqual(events.map(r => r.availability), auditAvailabilityProfile.availability.codes[EVENTS]);
  assert.deepEqual(episodes.map(r => r.availability), auditAvailabilityProfile.availability.codes[EPISODES]);
  for (const r of events) validateAuditAvailability(EVENTS, r);
  for (const r of episodes) validateAuditAvailability(EPISODES, r);
});

test('only producer_active lets an empty history mean no events', () => {
  const { events, episodes } = results();
  for (const r of [...events, ...episodes]) assert.equal(emptyHistoryMeansNone(r), r.availability === 'producer_active', r.availability);
  assert.equal(emptyHistoryMeansNone({ events: [] }), false);
  assert.equal(emptyHistoryMeansNone(null), false);
});

test('ops history allows only unavailable and active', () => {
  for (const code of ['producer_not_enqueuing', 'producer_starting', 'producer_stale', 'producer_degraded']) {
    const r = pick(results().episodes, 'producer_active');
    r.availability = code;
    assert.throws(() => validateAuditAvailability(EPISODES, r), undefined, code);
  }
});

for (const [name, op, code, mutate] of [
  ['unknown code', EVENTS, 'producer_active', r => { r.availability = 'producer_ok'; }],
  ['missing availability', EVENTS, 'producer_active', r => { r.availability = null; }],
  ['missing producer', EVENTS, 'producer_active', r => { delete r.producer; }],
  ['producer not an object', EVENTS, 'producer_active', r => { r.producer = 'ok'; }],
  ['extra producer field', EVENTS, 'producer_active', r => { r.producer.owner_id = 'x'; }],
  ['missing producer field', EVENTS, 'producer_active', r => { delete r.producer.held_by_reason; }],
  ['processing_enabled string', EVENTS, 'producer_active', r => { r.producer.processing_enabled = 'true'; }],
  ['pending negative', EVENTS, 'producer_active', r => { r.producer.pending = -1; }],
  ['pending fraction', EVENTS, 'producer_active', r => { r.producer.pending = 1.5; }],
  ['held string', EVENTS, 'producer_active', r => { r.producer.held = '0'; }],
  ['held_by_reason non-count', EVENTS, 'producer_active', r => { r.producer.held_by_reason = { poison: 'x' }; }],
  ['held_by_reason array', EVENTS, 'producer_active', r => { r.producer.held_by_reason = []; }],
  ['last_outcome unknown', EVENTS, 'producer_active', r => { r.producer.last_outcome = 'failed'; }],
  ['last_run_at not an instant', EVENTS, 'producer_active', r => { r.producer.last_run_at = 'yesterday'; }],
  ['counts_capped not boolean', EVENTS, 'producer_active', r => { r.producer.counts_capped = 0; }],
  ['active while processing off', EVENTS, 'producer_active', r => { r.producer.processing_enabled = false; }],
  ['active with no run', EVENTS, 'producer_active', r => { r.producer.last_run_at = null; }],
  ['active after a retry run', EVENTS, 'producer_active', r => { r.producer.last_outcome = 'retry'; }],
  ['active with processor_unavailable holds', EVENTS, 'producer_active', r => { r.producer.held_by_reason = { processor_unavailable: 1 }; }],
  ['unavailable while processing on', EVENTS, 'producer_unavailable', r => { r.producer.processing_enabled = true; }],
  ['not_enqueuing while enqueue on', EVENTS, 'producer_not_enqueuing', r => { r.producer.enqueue_enabled = true; }],
  ['starting after a run', EVENTS, 'producer_starting', r => { r.producer.last_run_at = '2026-11-26T12:00:00Z'; }],
  ['stale with no run', EVENTS, 'producer_stale', r => { r.producer.last_run_at = null; }],
  ['episodes producer extra field', EPISODES, 'producer_active', r => { r.producer.processing_enabled = true; }],
  ['episodes active while operations off', EPISODES, 'producer_active', r => { r.producer.operations_enabled = false; }],
  ['episodes unavailable while operations on', EPISODES, 'producer_unavailable', r => { r.producer.operations_enabled = true; }],
]) {
  test('reject ' + name, () => {
    const { events, episodes } = results();
    const r = pick(op === EVENTS ? events : episodes, code);
    mutate(r);
    assert.throws(() => validateAuditAvailability(op, r));
  });
}

test('1.3.0 stays frozen: its validator still rejects the new codes', () => {
  const r = syntheticAuditReadResults();
  r.observations.find(o => o.id === 'htp.website_audit_events.owner.producer_unavailable').result.availability = 'producer_active';
  assert.throws(() => validateAuditReadResults(auditReadFixtures, r));
  const profile = JSON.parse(readFileSync(fileURLToPath(new URL('../docs/plugin-contract/v1.3/audit-reads.json', import.meta.url)), 'utf8'));
  assert.equal(profile.availability.disabledValue, 'producer_unavailable');
});

test('the amendment is additive over 1.3.0 and keeps the held value', () => {
  assert.equal(auditAvailabilityProfile.contractVersion, '1.4.0');
  assert.equal(auditAvailabilityProfile.amends, '1.3.0');
  assert.equal(auditAvailabilityProfile.availability.heldValue, 'producer_unavailable');
  for (const codes of Object.values(auditAvailabilityProfile.availability.codes)) assert.ok(codes.includes('producer_unavailable') && codes.includes('producer_active'));
});
