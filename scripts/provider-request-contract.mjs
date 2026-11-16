// Semantic transcript validator, not a backend or a host adapter. No network.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { readJson } from './plugin-contract.mjs';
export const profile = readJson(new URL('../docs/plugin-contract/v1.1/provider-requests.json', import.meta.url));
const keyPattern = new RegExp(profile.limits.keyPattern);
const fields = (v, keys, message) => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v), message);
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort(), message);
};
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
const instant = v => {
  assert.ok(typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)), 'invalid timestamp');
  return Date.parse(v);
};
const identity = (website, key) => JSON.stringify([website, key]);
export function validateCollection(c) {
  fields(c, profile.collectionFields, 'collection shape');
  assert.ok(typeof c.requestKey === 'string' && keyPattern.test(c.requestKey), 'bounded request key');
  assert.ok(profile.statuses.includes(c.status), 'intent status is not execution status');
  instant(c.expiresAt);
  const a = c.association;
  fields(a, profile.associationFields, 'association shape');
  assert.ok(['google','bing'].includes(a.provider), 'provider');
  assert.ok(typeof a.fqdn === 'string' && a.fqdn.length > 0 && a.fqdn.length <= 253 && !/[\s/:@]/.test(a.fqdn), 'bounded fqdn');
  assert.ok(['analytics','conversions','search','properties','pagespeed','crux','business_locations','business_profile','business_performance','bing'].includes(a.kind), 'bounded kind');
  if (a.provider === 'bing') {
    assert.equal(a.kind, 'bing', 'Bing kind');
    for (const f of ['propertyId','startDate','endDate']) assert.equal(a[f], null, 'Bing job association uses explicit nulls');
  } else {
    assert.notEqual(a.kind, 'bing', 'Google kind');
    assert.ok(typeof a.propertyId === 'string' && a.propertyId.length <= 2048, 'bounded property');
    assert.ok(date(a.startDate) && date(a.endDate), 'valid association dates');
    const span = (Date.parse(a.endDate) - Date.parse(a.startDate)) / 86400000;
    assert.ok(span >= 0 && span < 366, 'bounded inclusive date range');
  }
}
// Context is supplied independently by an acceptance harness. Effects require
// measured database/worker evidence; asserted counters alone cannot prove them.
// No golden comparison: deadlines, keys and associations may vary lawfully.
export function validateProviderTrace(scenario, observations) {
  assert.ok(Array.isArray(scenario.steps) && scenario.steps.length > 0 && scenario.steps.length <= 128, 'bounded steps');
  assert.ok(Array.isArray(observations) && observations.length === scenario.steps.length, 'missing/extra steps');
  const known = new Map();
  const seen = new Set();
  for (let i = 0; i < scenario.steps.length; i++) {
    const s = scenario.steps[i], o = observations[i];
    assert.ok(!seen.has(s.id), 'duplicate step'); seen.add(s.id);
    fields(o, ['id','collection','error','effects'], 'observation shape');
    assert.equal(o.id, s.id, 'step order');
    assert.ok(['submit','lookup','cancel'].includes(s.action), 'unknown action');
    const now = instant(s.now);
    const r = s.request;
    assert.ok(typeof r.websiteId === 'string' && r.websiteId.length > 0, 'website scope required');
    const id = identity(r.websiteId, r.requestKey), prior = known.get(id);
    fields(o.effects, ['intentCreated','collectionJobsCreated','providerClaimsStarted','savedDataDeleted','otherIntentsWithdrawn','scheduledWorkCancelled'], 'effects shape');
    for (const [f,v] of Object.entries(o.effects)) assert.ok((s.action === 'submit' && s.failure === 'UNAVAILABLE' && ['intentCreated','collectionJobsCreated'].includes(f) && v === null) || (Number.isInteger(v) && v >= 0 && v <= 1), 'bounded effects: ' + f);
    for (const f of ['providerClaimsStarted','savedDataDeleted','otherIntentsWithdrawn','scheduledWorkCancelled']) assert.equal(o.effects[f], 0, 'registration/read/withdrawal cannot claim execution, delete data or cancel shared work');
    if (s.action !== 'submit') {
      assert.equal(o.effects.intentCreated, 0, 'lookup/cancel cannot register intent');
      assert.equal(o.effects.collectionJobsCreated, 0, 'lookup/cancel cannot register jobs');
    }
    let requiredError = null;
    if (s.authorized === false) requiredError = 'AUTH_REQUIRED';
    else if (s.owned === false) requiredError = 'NOT_FOUND';
    else if (s.capability === false) requiredError = 'UNSUPPORTED';
    else if (typeof r.requestKey !== 'string' || !keyPattern.test(r.requestKey) || s.invalidInput) requiredError = 'INVALID_ARGUMENT';
    else if (s.action === 'submit' && prior && !isDeepStrictEqual(r.input, prior.input)) requiredError = 'CONFLICT';
    else if (s.action === 'submit' && !prior && (s.activeCount >= 100 || s.retainedCount >= 1000)) requiredError = 'LIMIT_EXCEEDED';
    else if (s.failure) requiredError = s.failure;
    else if (s.action !== 'submit' && !prior) requiredError = 'NOT_FOUND';
    if (requiredError) {
      fields(o.error, ['code'], 'bounded error shape');
      assert.ok([...profile.backendErrors,...profile.localErrors].includes(o.error.code), 'bounded error code');
      assert.equal(o.error.code, requiredError, 'required rejection');
      assert.equal(o.collection, null, 'rejection must not disclose association');
      assert.equal(o.effects.collectionJobsCreated, requiredError === 'UNAVAILABLE' && s.action === 'submit' ? null : 0, 'uncertainty must remain unknown; definite rejection cannot claim jobs');
      assert.equal(o.effects.intentCreated, requiredError === 'UNAVAILABLE' && s.action === 'submit' ? null : 0, 'uncertainty must remain unknown; definite rejection cannot claim registration');
      // UNAVAILABLE/transport loss is an uncertain result, not proof that no
      // transaction committed. Harnesses may seed a later reconciled result.
      if (s.committedAfterLoss) {
        assert.equal(requiredError, 'UNAVAILABLE', 'only uncertainty can seed reconciliation');
        validateCollection(s.committedAfterLoss);
        assert.equal(s.committedAfterLoss.requestKey, r.requestKey, 'reconciled key');
        assert.deepEqual(s.committedAfterLoss.association, s.association, 'reconciled association');
        assert.equal(instant(s.committedAfterLoss.expiresAt), now + 604800000, 'fixed deadline');
        known.set(id, { collection: structuredClone(s.committedAfterLoss), input: r.input });
      }
      continue;
    }
    assert.equal(o.error, null, 'successful operation has no error');
    validateCollection(o.collection);
    assert.equal(o.collection.requestKey, r.requestKey, 'request key association');
    if (prior) {
      const expected = structuredClone(prior.collection);
      if (expected.status === 'accepted' && now >= instant(expected.expiresAt)) expected.status = 'expired';
      if (s.action === 'cancel' && expected.status === 'accepted') expected.status = 'withdrawn';
      assert.deepEqual(o.collection, expected, 'retry/read/cancel retains association/deadline and cannot revive terminal intent');
      assert.equal(o.effects.intentCreated, 0, 'retry cannot duplicate intent');
      assert.equal(o.effects.collectionJobsCreated, 0, 'retry cannot duplicate job');
    } else {
      assert.equal(s.action, 'submit');
      assert.equal(o.collection.status, 'accepted', 'new intent accepted');
      assert.equal(instant(o.collection.expiresAt), now + 604800000, 'seven day deadline');
      assert.deepEqual(o.collection.association, s.association, 'public natural-key job association');
      assert.equal(o.effects.intentCreated, 1, 'new intent registered once');
      if (s.sharedJob) assert.equal(o.effects.collectionJobsCreated, 0, 'shared job reused');
    }
    known.set(id, { collection: structuredClone(o.collection), input: prior?.input ?? r.input });
  }
}
export function validateProviderResults(fixtures, results) {
  assert.equal(fixtures.contractVersion, '1.1.0');
  assert.equal(fixtures.evidenceKind, 'synthetic');
  assert.ok(Array.isArray(fixtures.scenarios) && fixtures.scenarios.length > 0 && fixtures.scenarios.length <= 128, 'bounded scenarios');
  fields(results, ['contractVersion','host','observations'], 'results envelope');
  assert.equal(results.contractVersion, fixtures.contractVersion);
  assert.ok(['claude','codex','pi','backend'].includes(results.host), 'unknown observation target');
  assert.equal(results.observations.length, fixtures.scenarios.length, 'missing/extra scenarios');
  const seen = new Set();
  for (const o of results.observations) {
    fields(o, ['id','steps'], 'trace envelope');
    assert.ok(!seen.has(o.id), 'duplicate scenario'); seen.add(o.id);
    const s = fixtures.scenarios.find(s => s.id === o.id);
    assert.ok(s, 'unknown scenario');
    validateProviderTrace(s, o.steps);
  }
  assert.equal(new Set(fixtures.scenarios.map(s => s.id)).size, fixtures.scenarios.length, 'duplicate fixture scenario');
}
