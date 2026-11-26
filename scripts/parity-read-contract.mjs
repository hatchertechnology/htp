// Offline semantic validator for additive parity read profile 1.4.0.
// No network, credentials, shell or crawler; executes no backend or host.
import assert from 'node:assert/strict';
import { readJson } from './plugin-contract.mjs';

export const parityReadProfile = readJson(new URL('../docs/plugin-contract/v1.4/parity-reads.json', import.meta.url));
export const parityReadFixtures = readJson(new URL('../docs/plugin-contract/v1.4/conformance.json', import.meta.url));

const fields = (v, names, message = 'field inventory') => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v), 'object required');
  assert.deepEqual(Object.keys(v).sort(), [...names].sort(), message);
};
const uuid = v => assert.match(v, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'UUID');
const instant = v => assert.ok(typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)), 'RFC3339 instant');
const contextFields = ['authorized', 'owner', 'capability', 'anonymous', 'held', 'limit', 'before', 'before_id'];

export function parityReadOperation(scenario) {
  const operation = parityReadProfile.operations.find(o => o.id === scenario.operation);
  assert.ok(operation, 'unknown parity read operation: ' + scenario.operation);
  return operation;
}

// Required rejection derived independently of the golden expected result.
export function requiredParityReadRejection(scenario) {
  const c = scenario.context;
  const operation = parityReadOperation(scenario);
  fields(c, contextFields, 'scenario context');
  for (const key of ['authorized', 'owner', 'capability', 'anonymous', 'held']) assert.equal(typeof c[key], 'boolean', 'context ' + key);
  if (!c.authorized) return 'auth_required';
  if (!c.owner) return 'forbidden';
  if (!c.capability) return 'unsupported';
  if (c.held) return 'unavailable';
  if (operation.pageBound === 'limit') {
    assert.ok(Number.isInteger(c.limit), 'context limit');
    if (c.limit < parityReadProfile.limits.limitMin || c.limit > parityReadProfile.limits.limitMax) return 'invalid_cursor_or_limit';
  } else assert.equal(c.limit, null, 'remediation has no limit');
  if ((c.before === null) !== (c.before_id === null)) return 'invalid_cursor_or_limit';
  if (c.before !== null) { instant(c.before); uuid(c.before_id); }
  return null;
}

export function validateParityReadObservation(scenario, observation) {
  const operation = parityReadOperation(scenario);
  fields(observation, ['id', 'result', 'effects'], 'trace envelope');
  assert.equal(observation.id, scenario.id, 'scenario order');
  fields(observation.effects, ['collectionRegistered', 'crawlRunsCreated', 'writes'], 'effects shape');
  assert.equal(observation.effects.collectionRegistered, false, 'parity reads cannot register collection');
  assert.equal(observation.effects.crawlRunsCreated, 0, 'parity reads cannot schedule crawl runs');
  assert.equal(observation.effects.writes, 0, 'parity reads cannot write');
  const rejection = requiredParityReadRejection(scenario);
  const result = observation.result;
  if (rejection) {
    // A held read is explicit and never an empty page.
    fields(result, ['code'], 'rejection shape');
    assert.ok(parityReadProfile.errors.includes(result.code), 'bounded error code');
    assert.equal(result.code, rejection, 'required rejection: ' + scenario.id);
    return;
  }
  fields(result, operation.resultFields, 'success shape');
  assert.equal(result[operation.versionField], 1, 'profile version');
  if (operation.binding === 'website_remediation_list') {
    uuid(result.delivery_id);
    assert.ok(Number.isInteger(result.finding_index) && result.finding_index >= 0, 'finding_index');
  } else assert.equal(typeof result.entity_id, 'string', 'entity_id');
  const page = result[operation.pageField];
  assert.ok(Array.isArray(page), 'page array required');
  assert.equal(typeof result.has_more, 'boolean', 'has_more boolean');
  if (result.has_more) {
    if (operation.pageBound === 'limit') assert.equal(page.length, scenario.context.limit, 'a full page is required to advertise more');
    assert.ok(result.next_cursor && typeof result.next_cursor === 'object' && !Array.isArray(result.next_cursor), 'next_cursor object');
    fields(result.next_cursor, ['before', 'before_id'], 'cursor shape');
    instant(result.next_cursor.before);
    uuid(result.next_cursor.before_id);
  } else {
    assert.equal(result.next_cursor, null, 'last page has no cursor');
  }
  if (operation.pageBound === 'limit') assert.ok(page.length <= scenario.context.limit, 'page bounded by limit');
  else assert.ok(page.length <= 1, 'one work item per finding');
  for (const item of page) assert.ok(item && typeof item === 'object' && !Array.isArray(item), 'page item object');
}

export function validateParityReadResults(fixtures, results) {
  assert.equal(fixtures.contractVersion, parityReadProfile.contractVersion);
  assert.equal(fixtures.evidenceKind, 'synthetic');
  assert.ok(Array.isArray(fixtures.scenarios) && fixtures.scenarios.length > 0 && fixtures.scenarios.length <= 128, 'bounded scenarios');
  assert.equal(new Set(fixtures.scenarios.map(s => s.id)).size, fixtures.scenarios.length, 'duplicate scenario');
  fields(results, ['contractVersion', 'host', 'observations'], 'results envelope');
  assert.equal(results.contractVersion, fixtures.contractVersion);
  assert.ok(['backend', 'claude', 'codex', 'pi'].includes(results.host), 'unknown host');
  assert.ok(Array.isArray(results.observations), 'observations array required');
  assert.equal(results.observations.length, fixtures.scenarios.length, 'missing or extra scenario');
  const seen = new Set();
  for (const observation of results.observations) {
    fields(observation, ['id', 'result', 'effects'], 'trace envelope');
    assert.ok(!seen.has(observation.id), 'duplicate observation');
    seen.add(observation.id);
    const scenario = fixtures.scenarios.find(s => s.id === observation.id);
    assert.ok(scenario, 'unknown scenario');
    validateParityReadObservation(scenario, observation);
    assert.deepEqual(observation, { id: scenario.id, ...structuredClone(scenario.expected) }, 'observation differs from synthetic contract');
  }
}

export function syntheticParityReadResults(host = 'backend') {
  return {
    contractVersion: parityReadProfile.contractVersion,
    host,
    observations: parityReadFixtures.scenarios.map(s => ({ id: s.id, ...structuredClone(s.expected) })),
  };
}
