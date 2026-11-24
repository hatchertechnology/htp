import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditReadFixtures,
  syntheticAuditReadResults,
  validateAuditReadObservation,
  validateAuditReadResults,
} from './audit-read-contract.mjs';

const trace = (results, id) => results.observations.find(o => o.id === id);

test('all hosts validate the synthetic owner, producer-unavailable and denial transcripts', () => {
  for (const host of ['backend', 'claude', 'codex', 'pi']) {
    assert.equal(validateAuditReadResults(auditReadFixtures, syntheticAuditReadResults(host)), undefined);
  }
});

for (const [name, id, mutate] of [
  ['missing producer availability', 'htp.website_audit_events.owner.page', o => { o.result.availability = 'ok'; }],
  ['empty page erases producer state', 'htp.website_audit_events.owner.producer_unavailable', o => { o.result.availability = null; }],
  ['last page keeps a cursor', 'htp.website_audit_events.owner.trailing_page', o => { o.result.next_cursor = { before: '2026-11-21T00:00:00Z', before_id: '00000000-0000-4000-8000-0000000000a1' }; }],
  ['more advertised on a short page', 'htp.website_audit_events.owner.page', o => { o.result.events = []; }],
  ['page item is not an object', 'htp.website_audit_events.owner.page', o => { o.result.events = ['raw']; }],
  ['wrong profile version', 'htp.website_operational_episodes.owner.page', o => { o.result.version = 2; }],
  ['episodes page erased', 'htp.website_operational_episodes.owner.page', o => { o.result.episodes = []; }],
  ['read registers collection', 'htp.website_audit_events.owner.page', o => { o.effects.collectionRegistered = true; }],
  ['read schedules crawl runs', 'htp.website_audit_events.owner.page', o => { o.effects.crawlRunsCreated = 1; }],
  ['anonymous denial erased', 'htp.website_audit_events.anonymous', o => { o.result = { semantics_version: 1, events: [], has_more: false, next_cursor: null, availability: 'producer_unavailable' }; }],
  ['owner denial erased', 'htp.website_operational_episodes.non_owner', o => { o.result = { version: 1, episodes: [], has_more: false, next_cursor: null, availability: 'producer_unavailable' }; }],
  ['missing capability succeeds', 'htp.website_audit_events.missing_capability', o => { o.result = { semantics_version: 1, events: [], has_more: false, next_cursor: null, availability: 'producer_unavailable' }; }],
  ['unpaired cursor accepted', 'htp.website_audit_events.unpaired_cursor', o => { o.result = { semantics_version: 1, events: [], has_more: false, next_cursor: null, availability: 'producer_unavailable' }; }],
  ['out-of-range limit accepted', 'htp.website_operational_episodes.limit_out_of_range', o => { o.result = { version: 1, episodes: [], has_more: false, next_cursor: null, availability: 'producer_unavailable' }; }],
  ['unknown error code', 'htp.website_audit_events.anonymous', o => { o.result.code = 'other_error'; }],
  ['unexpected field', 'htp.website_audit_events.owner.page', o => { o.result.credentials = 'fixture-only'; }],
]) {
  test('reject ' + name, () => {
    const results = syntheticAuditReadResults();
    mutate(trace(results, id));
    assert.throws(() => validateAuditReadResults(auditReadFixtures, results));
  });
}

test('reject missing, extra, duplicate and unknown scenarios', () => {
  for (const mutate of [
    r => r.observations.pop(),
    r => r.observations.push(r.observations[0]),
    r => { r.observations[1] = r.observations[0]; },
    r => { r.observations[0].id = 'unknown'; },
    r => { r.contractVersion = '1.2.0'; },
    r => { r.host = 'unknown'; },
    r => { r.credentials = 'fixture-only'; },
  ]) {
    const results = syntheticAuditReadResults();
    mutate(results);
    assert.throws(() => validateAuditReadResults(auditReadFixtures, results));
  }
});

// Mutate expected and observation together: golden equality cannot reject these.
for (const [name, id, patch, message] of [
  ['authorization', 'htp.website_audit_events.anonymous', { code: 'unavailable' }, /required rejection/],
  ['owner denial', 'htp.website_audit_events.non_owner', { code: 'auth_required' }, /required rejection/],
  ['capability gate', 'htp.website_audit_events.missing_capability', { code: 'unavailable' }, /required rejection/],
  ['cursor pairing', 'htp.website_audit_events.unpaired_cursor', { code: 'unavailable' }, /required rejection/],
  ['limit bounds', 'htp.website_operational_episodes.limit_out_of_range', { code: 'unavailable' }, /required rejection/],
  ['producer availability', 'htp.website_audit_events.owner.page', { availability: 'ok' }, /explicit producer availability/],
  ['page bound', 'htp.website_audit_events.owner.page', { events: [] }, /full page/],
  ['collection side effect', 'htp.website_audit_events.owner.page', null, /cannot register collection/],
]) {
  test('independent invariant: ' + name, () => {
    const scenario = structuredClone(auditReadFixtures.scenarios.find(s => s.id === id));
    if (patch) Object.assign(scenario.expected.result, patch);
    else scenario.expected.effects.collectionRegistered = true;
    assert.throws(() => validateAuditReadObservation(scenario, { id: scenario.id, ...scenario.expected }), message);
  });
}

test('CLI labels synthetic evidence and rejects mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-read-'));
  try {
    const path = join(dir, 'results.json');
    const run = results => {
      writeFileSync(path, JSON.stringify(results));
      return spawnSync(process.execPath, [fileURLToPath(new URL('./check-audit-read-contract.mjs', import.meta.url)), '--audit-read-results', path], { encoding: 'utf8', timeout: 10000 });
    };
    assert.match(run(syntheticAuditReadResults()).stdout, /Synthetic/);
    const mutated = syntheticAuditReadResults();
    trace(mutated, 'htp.website_audit_events.anonymous').result.code = 'unavailable';
    assert.notEqual(run(mutated).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
