import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parityReadFixtures,
  parityReadProfile,
  syntheticParityReadResults,
  validateParityReadResults,
} from './parity-read-contract.mjs';
import { readJson } from './plugin-contract.mjs';

const trace = (results, id) => results.observations.find(o => o.id === id);
const EMPTY = { version: 1, entity_id: 'e', items: [], has_more: false, next_cursor: null };

test('all hosts validate the synthetic owner, held and denial transcripts', () => {
  for (const host of ['backend', 'claude', 'codex', 'pi']) {
    assert.equal(validateParityReadResults(parityReadFixtures, syntheticParityReadResults(host)), undefined);
  }
});

test('1.4.0 is the additive minor profile naming the three reads, none in earlier inventories', () => {
  assert.equal(parityReadProfile.contractVersion, '1.4.0');
  assert.deepEqual(parityReadProfile.extends, ['1.0.0', '1.1.0', '1.2.0', '1.3.0']);
  const bindings = parityReadProfile.operations.map(o => o.binding).sort();
  assert.deepEqual(bindings, ['website_audit_lifecycle', 'website_remediation_list', 'website_url_lifecycle']);
  const earlier = [
    readJson(new URL('../docs/plugin-contract/v1/capabilities.json', import.meta.url)).operations.map(o => o.binding),
    ...['v1.1/provider-requests', 'v1.2/audit-exports', 'v1.3/audit-reads'].map(f =>
      readJson(new URL(`../docs/plugin-contract/${f}.json`, import.meta.url)).operations.map(o => o.binding)),
  ].flat();
  for (const binding of bindings) assert.ok(!earlier.includes(binding), binding + ' belongs only to 1.4.0');
  for (const op of parityReadProfile.operations) {
    assert.equal(op.effect, 'read');
    assert.equal(op.collection, false);
    assert.equal(op.destructive, false);
  }
});

test('every operation covers owner pages, held, denials and cursor errors', () => {
  const ids = parityReadFixtures.scenarios.map(s => s.id);
  for (const op of parityReadProfile.operations) {
    const suffixes = ['.owner.page', '.owner.trailing_page', '.held', '.anonymous', '.non_owner', '.missing_capability', '.unpaired_cursor'];
    if (op.pageBound === 'limit') suffixes.push('.limit_out_of_range');
    for (const suffix of suffixes) assert.ok(ids.includes(op.id + suffix), op.id + suffix);
  }
});

test('the contract names the same rollout flags the API holds', () => {
  const lib = readFileSync(fileURLToPath(new URL('../apps/api/src/lib.rs', import.meta.url)), 'utf8');
  for (const op of parityReadProfile.operations) assert.ok(lib.includes(`"${op.rolloutFlag}"`), op.rolloutFlag);
});

for (const [name, id, mutate] of [
  ['held erased into an empty page', 'htp.website_audit_lifecycle.held', o => { o.result = { ...EMPTY, rule: 'r' }; }],
  ['held remediation erased into an empty queue', 'htp.website_remediation_list.held', o => { o.result = { version: 1, delivery_id: '00000000-0000-4000-8000-0000000000c1', finding_index: 0, items: [], has_more: false, next_cursor: null }; }],
  ['url lifecycle held erased', 'htp.website_url_lifecycle.held', o => { o.result = EMPTY; }],
  ['last page keeps a cursor', 'htp.website_url_lifecycle.owner.trailing_page', o => { o.result.next_cursor = { before: '2026-11-21T00:00:00Z', before_id: '00000000-0000-4000-8000-0000000000a1' }; }],
  ['more advertised on a short page', 'htp.website_audit_lifecycle.owner.page', o => { o.result.items = []; }],
  ['remediation returns two work items', 'htp.website_remediation_list.owner.trailing_page', o => { o.result.items = [o.result.items[0], o.result.items[0]]; }],
  ['wrong profile version', 'htp.website_remediation_list.owner.page', o => { o.result.version = 2; }],
  ['read registers collection', 'htp.website_audit_lifecycle.owner.page', o => { o.effects.collectionRegistered = true; }],
  ['read schedules crawl runs', 'htp.website_url_lifecycle.owner.page', o => { o.effects.crawlRunsCreated = 1; }],
  ['read writes', 'htp.website_remediation_list.owner.page', o => { o.effects.writes = 1; }],
  ['anonymous denial erased', 'htp.website_audit_lifecycle.anonymous', o => { o.result = { ...EMPTY, rule: 'r' }; }],
  ['owner denial erased', 'htp.website_remediation_list.non_owner', o => { o.result = { version: 1, delivery_id: '00000000-0000-4000-8000-0000000000c1', finding_index: 0, items: [], has_more: false, next_cursor: null }; }],
  ['missing capability succeeds', 'htp.website_url_lifecycle.missing_capability', o => { o.result = EMPTY; }],
  ['unpaired cursor accepted', 'htp.website_audit_lifecycle.unpaired_cursor', o => { o.result = { ...EMPTY, rule: 'r' }; }],
  ['out-of-range limit accepted', 'htp.website_url_lifecycle.limit_out_of_range', o => { o.result = EMPTY; }],
  ['unknown error code', 'htp.website_audit_lifecycle.anonymous', o => { o.result.code = 'other_error'; }],
  ['unexpected field', 'htp.website_audit_lifecycle.owner.page', o => { o.result.credentials = 'fixture-only'; }],
]) {
  test('reject ' + name, () => {
    const results = syntheticParityReadResults();
    mutate(trace(results, id));
    assert.throws(() => validateParityReadResults(parityReadFixtures, results));
  });
}

test('reject missing, extra, duplicate and unknown scenarios', () => {
  for (const mutate of [
    r => r.observations.pop(),
    r => r.observations.push(r.observations[0]),
    r => { r.observations[1] = r.observations[0]; },
    r => { r.observations[0].id = 'unknown'; },
    r => { r.contractVersion = '1.3.0'; },
    r => { r.host = 'unknown'; },
    r => { r.credentials = 'fixture-only'; },
  ]) {
    const results = syntheticParityReadResults();
    mutate(results);
    assert.throws(() => validateParityReadResults(parityReadFixtures, results));
  }
});
