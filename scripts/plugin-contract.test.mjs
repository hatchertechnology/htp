import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, validateObservation, validateResults, MAX_FILE_BYTES } from './plugin-contract.mjs';
const fixtures = readJson(new URL('../docs/plugin-contract/v1/conformance.json', import.meta.url));
const { operations } = readJson(new URL('../docs/plugin-contract/v1/capabilities.json', import.meta.url));
const results = () => ({ contractVersion: '1.0.0', host: 'codex', observations: fixtures.scenarios.map(s => ({ id: s.id, result: structuredClone(s.expected) })) });
const check = value => validateResults(fixtures, value, operations);
function change(id, update) {
  const value = results();
  update(value.observations.find(o => o.id === id).result);
  return value;
}
test('canonical scenarios validate for every host', () => {
  for (const host of ['claude', 'codex', 'pi']) check({ ...results(), host });
});
for (const [name, id, patch] of [
  ['saved read schedules', 'htp.saved_reads.no_collection', { crawlRunsCreated: 1 }],
  ['expired auth becomes empty success', 'htp.auth.expired', { status: 'ok', code: null }],
  ['cross website data leaks', 'htp.cross_website.denied', { source: 'stored', bytes: 10 }],
  ['missing capability silently succeeds', 'htp.missing_capability', { status: 'ok', code: null }],
  ['partial falsely passes', 'seosmith.report.partial', { outcome: 'pass' }],
  ['truncated becomes complete', 'seosmith.report.truncated', { coverage: 'complete' }],
  ['retry duplicates', 'seosmith.retry.same_request', { crawlRunsCreated: 1 }],
  ['retry identity changes', 'seosmith.retry.same_request', { requestId: '22222222-2222-4222-8222-222222222222' }],
  ['payload conflict disappears', 'seosmith.retry.conflict', { code: null }],
  ['cancel acceptance becomes terminal', 'seosmith.cancel.accepted', { status: 'cancelled' }],
  ['oversized report leaks', 'seosmith.oversized_report', { bytes: 16777217 }],
  ['unknown report version', 'seosmith.report.complete', { reportSchema: 99 }],
  ['v2 bypasses receiver gate', 'seosmith.report.complete', { reportSchema: 2 }],
  ['future major accepted', 'contract.major_mismatch', { status: 'accepted', code: null }],
  ['unconfigured worker starts', 'seosmith.unconfigured_worker', { status: 'accepted', crawlRunsCreated: 1 }],
  ['invalid scope starts', 'seosmith.invalid_scope', { status: 'accepted', crawlRunsCreated: 1 }],
  ['outage becomes empty success', 'seosmith.worker_outage', { status: 'ok', code: null }],
  ['unexpected credential field', 'htp.saved_reads.no_collection', { access_token: 'fixture-only' }],
  ['invalid job count', 'seosmith.start.bounded', { crawlRunsCreated: -1 }],
]) test(`reject ${name}`, () => assert.throws(() => check(change(id, result => Object.assign(result, patch)))));
for (const [name, update] of [
  ['missing', v => v.observations.pop()],
  ['extra', v => v.observations.push(v.observations[0])],
  ['duplicate', v => { v.observations[1] = v.observations[0]; }],
  ['unknown', v => { v.observations[0].id = 'unknown'; }],
  ['wrong version', v => { v.contractVersion = '2.0.0'; }],
  ['wrong host', v => { v.host = 'other'; }],
  ['untrusted metadata', v => { v.credentials = 'fixture-only'; }],
  ['missing result field', v => { delete v.observations[0].result.bytes; }],
]) test(`reject ${name} transcript`, () => { const value = results(); update(value); assert.throws(() => check(value)); });
test('file input is bounded before parsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-contract-'));
  try {
    const path = join(dir, 'too-large.json');
    writeFileSync(path, ' '.repeat(MAX_FILE_BYTES + 1));
    assert.throws(() => readJson(path), /exceeds 1 MiB/);
    writeFileSync(path, '{');
    assert.throws(() => readJson(path), SyntaxError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('scenario count is bounded', () => {
  assert.throws(() => validateResults({ ...fixtures, scenarios: Array(129).fill(fixtures.scenarios[0]) }, results(), operations));
});
for (const [name, id, patch] of [
  ['collection registration omitted', 'htp.report.collect', { collectionRegistered: false }],
  ['read registers collection', 'htp.saved_reads.no_collection', { collectionRegistered: true }],
  ['non-owner write succeeds', 'htp.write.non_owner', { status: 'ok', code: null }],
  ['deduplicated import starts crawl', 'htp.import.dedupe', { crawlRunsCreated: 1 }],
  ['delete loses acknowledgement', 'htp.delete.explicit', { status: 'pending' }],
]) test(`reject ${name}`, () => assert.throws(() => check(change(id, result => Object.assign(result, patch)))));
test('collection refresh registration is independent of stored sync state', () => {
  for (const state of ['ready', 'stale', 'error']) {
    const id = 'htp.report.collect.' + state;
    check(results());
    assert.throws(() => check(change(id, r => { r.collectionRegistered = false; })));
  }
});
test('repository collection registration is preserved', () => {
  assert.throws(() => check(change('htp.repository.collection', r => { r.collectionRegistered = false; })));
});
test('external mode deliberately requires golden unknown outcome', () => {
  assert.throws(() => check(change('seosmith.report.complete', r => { r.outcome = 'pass'; })));
});


// Mutate expected and observed together: golden equality cannot reject these.
// Each assertion must come from the named independent invariant.
for (const [name, id, patch, message] of [
  ['read scheduling', 'htp.saved_reads.no_collection', { crawlRunsCreated: 1 }, /reads cannot schedule/],
  ['rejection scheduling', 'seosmith.unconfigured_worker', { crawlRunsCreated: 1 }, /rejection cannot create jobs/],
  ['rejection payload', 'seosmith.unconfigured_worker', { source: 'stored' }, /rejection cannot return data/],
  ['authorization', 'htp.auth.expired', { code: 'other_error' }, /authorization must fail closed/],
  ['owner denial', 'htp.write.non_owner', { code: 'auth_required' }, /owner denial required/],
  ['capability gate', 'htp.missing_capability', { status: 'ok' }, /missing capability must be explicit/],
  ['major version', 'contract.major_mismatch', { code: 'other_error' }, /incompatible major/],
  ['request identity', 'seosmith.start.bounded', { requestId: '22222222-2222-4222-8222-222222222222' }, /new run must retain request identity/],
  ['retry dedupe', 'seosmith.retry.same_request', { crawlRunsCreated: 1 }, /retry cannot duplicate a run/],
  ['retry identity', 'seosmith.retry.same_request', { requestId: '22222222-2222-4222-8222-222222222222' }, /retry identity changed/],
  ['conflict evidence', 'seosmith.retry.conflict', { code: 'other_error' }, /changed payload must conflict/],
  ['v2 gate', 'seosmith.report.complete', { reportSchema: 2 }, /v2 needs explicit receiver gate/],
  ['report size', 'seosmith.report.complete', { bytes: 16777217 }, /unbounded report/],
  ['unknown evaluation', 'seosmith.report.complete', { outcome: 'pass' }, /no evaluation proof/],
]) test('independent invariant: ' + name, () => {
  const scenario = structuredClone(fixtures.scenarios.find(s => s.id === id));
  Object.assign(scenario.expected, patch);
  assert.throws(() => validateObservation(scenario, structuredClone(scenario.expected), operations), message);
});
test('independent invariant: explicit start intent', () => {
  const scenario = structuredClone(fixtures.scenarios.find(s => s.id === 'seosmith.start.bounded'));
  scenario.context.explicit = false;
  assert.throws(() => validateObservation(scenario, scenario.expected, operations), /scan requires explicit intent/);
});
test('golden equality still rejects otherwise valid transcript variation', () => {
  const scenario = fixtures.scenarios.find(s => s.id === 'seosmith.report.complete');
  assert.throws(() => validateObservation(scenario, { ...scenario.expected, bytes: scenario.expected.bytes + 1 }, operations), /observation differs from contract/);
});
