// Offline contract assertions only. No network, credentials, shell, or crawler.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
export const MAX_SCENARIOS = 128;
export function readJson(path) {
  assert.ok(statSync(path).size <= MAX_FILE_BYTES, 'JSON input exceeds 1 MiB');
  return JSON.parse(readFileSync(path, 'utf8'));
}
const statuses = new Set(['ok', 'accepted', 'pending', 'running', 'cancelling', 'cancelled', 'error', 'unsupported']);
const fields = ['status', 'code', 'jobsCreated', 'requestId', 'coverage', 'outcome', 'source', 'reportSchema', 'bytes', 'retryable'].sort();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateObservation(scenario, value, operations) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'observation object required');
  assert.deepEqual(Object.keys(value).sort(), fields, 'unexpected or missing result fields');
  const op = operations.find(op => op.id === scenario.operation);
  assert.ok(op, 'unknown operation');
  assert.ok(statuses.has(value.status), 'unknown status');
  assert.ok(value.code === null || /^[a-z_]{1,64}$/.test(value.code), 'invalid error code');
  assert.ok(Number.isInteger(value.jobsCreated) && value.jobsCreated >= 0 && value.jobsCreated <= 1, 'unbounded job count');
  assert.ok(value.requestId === null || (typeof value.requestId === 'string' && uuid.test(value.requestId)), 'invalid request identity');
  assert.ok(['unknown', 'complete', 'partial', 'truncated'].includes(value.coverage), 'unknown coverage');
  // Crawl completeness alone is never sufficient to synthesize a passing evaluation.
  assert.equal(value.outcome, 'unknown', 'these fixtures contain no evaluation proof of pass/fail');
  assert.ok(['none', 'stored', 'local', 'private-worker', 'provider-collection'].includes(value.source), 'unknown source');
  assert.ok([null, 1, 2].includes(value.reportSchema), 'unsupported report schema');
  assert.ok(Number.isInteger(value.bytes) && value.bytes >= 0 && value.bytes <= MAX_REPORT_BYTES, 'unbounded report');
  assert.equal(typeof value.retryable, 'boolean');
  if (op.effect === 'read') assert.equal(value.jobsCreated, 0, 'reads cannot schedule');
  if (['error', 'unsupported'].includes(value.status)) {
    assert.equal(value.jobsCreated, 0, 'rejection cannot create jobs');
    assert.ok(value.code, 'rejection requires error code');
    assert.equal(value.source, 'none', 'rejection cannot return data');
    assert.equal(value.bytes, 0, 'rejection cannot return report bytes');
  }
  const c = scenario.context;
  if (!c.authorized) assert.ok(['auth_required', 'forbidden'].includes(value.code), 'authorization must fail closed');
  if (!c.capability) assert.equal(value.status, 'unsupported', 'missing capability must be explicit');
  if (c.contractMajor !== 1) assert.equal(value.code, 'unsupported_version', 'incompatible major');
  if (value.jobsCreated) {
    assert.equal(c.explicit, true, 'scan requires explicit intent');
    assert.equal(value.requestId, c.requestId, 'new run must retain request identity');
  }
  if (c.priorRequestId) {
    assert.equal(value.jobsCreated, 0, 'retry cannot duplicate a run');
    if (c.samePayload) assert.equal(value.requestId, c.priorRequestId, 'retry identity changed');
    else assert.equal(value.code, 'identity_conflict', 'changed payload must conflict');
  }
  if (value.reportSchema === 2) assert.equal(c.receiverV2, true, 'v2 needs explicit receiver gate');
  // Exact expected transcript includes cancellation acceptance vs terminal state,
  // auth expiry vs disconnected provider, invalid bounds, and no silent truncation.
  assert.deepEqual(value, scenario.expected, `${scenario.id}: observation differs from contract`);
}
export function validateResults(fixtures, results, operations) {
  assert.equal(fixtures.contractVersion, '1.0.0');
  assert.ok(Array.isArray(fixtures.scenarios) && fixtures.scenarios.length > 0 && fixtures.scenarios.length <= MAX_SCENARIOS);
  assert.equal(new Set(fixtures.scenarios.map(s => s.id)).size, fixtures.scenarios.length, 'duplicate scenario');
  assert.deepEqual(Object.keys(results).sort(), ['contractVersion', 'host', 'observations'], 'invalid results envelope');
  assert.equal(results.contractVersion, fixtures.contractVersion);
  assert.ok(['claude', 'codex', 'pi'].includes(results.host), 'unknown host');
  assert.ok(Array.isArray(results.observations) && results.observations.length === fixtures.scenarios.length, 'missing or extra scenario');
  const seen = new Set();
  for (const item of results.observations) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'result']);
    assert.ok(!seen.has(item.id), 'duplicate observation');
    seen.add(item.id);
    const scenario = fixtures.scenarios.find(s => s.id === item.id);
    assert.ok(scenario, 'unknown scenario');
    validateObservation(scenario, item.result, operations);
  }
}
