// Semantic transcript validator, not a backend or a host adapter. No network.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { readJson } from './plugin-contract.mjs';
export const profile = readJson(new URL('../docs/plugin-contract/v1.1/provider-requests.json', import.meta.url));
const TTL_MS = profile.limits.ttlSeconds * 1000;
const keyPattern = new RegExp(profile.limits.keyPattern);
const fields = (v, keys, message) => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v), message);
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort(), message);
};
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
const instant = v => {
  assert.ok(typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, 'invalid timestamp');
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
    assert.ok(span >= 0 && span < profile.limits.inclusiveRangeDays, 'bounded inclusive date range');
  }
}
const undated = new Set(['properties','pagespeed','crux','business_locations','business_profile']);
const kinds = new Set(['analytics','conversions','search','properties','pagespeed','crux','business_locations','business_profile','business_performance','bing']);
function validInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['kind','propertyId','startDate','endDate'].includes(k)) || !kinds.has(input.kind)) return false;
  if (input.propertyId != null && (typeof input.propertyId !== 'string' || input.propertyId.length > 2048)) return false;
  const start=input.startDate ?? null, end=input.endDate ?? null;
  if (start === null && end === null) return undated.has(input.kind) || input.kind === 'bing';
  if (!date(start) || !date(end)) return false;
  const span=(Date.parse(end)-Date.parse(start))/86400000;
  return span >= 0 && span < profile.limits.inclusiveRangeDays && (input.kind !== 'bing' || start >= '2000-01-01');
}
function checkInputAssociation(input, association) {
  assert.ok(validInput(input), 'successful registration requires valid input');
  const bing=input.kind === 'bing';
  assert.deepEqual(association, {
    provider:bing ? 'bing' : 'google', kind:input.kind,
    propertyId:bing ? null : input.kind === 'properties' ? '' : input.propertyId ?? '',
    startDate:bing ? null : undated.has(input.kind) ? '1970-01-01' : input.startDate,
    endDate:bing ? null : undated.has(input.kind) ? '1970-01-01' : input.endDate,
    fqdn:association.fqdn,
  }, 'input/job association mismatch');
}
function workState(value) {
  fields(value,['leasedClaims','scheduledJobs','activeOtherIntents','savedSnapshots'],'work state shape');
  for (const count of Object.values(value)) assert.ok(Number.isInteger(count) && count >= 0 && count <= 10000,'bounded work state');
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
    fields(o, ['id','collection','error','effects',...(s.workBefore ? ['workAfter'] : [])], 'observation shape');
    if (s.workBefore) { workState(s.workBefore); workState(o.workAfter); assert.deepEqual(o.workAfter,s.workBefore,'withdrawal must preserve measured leased/scheduled/other-intent/snapshot state'); }
    assert.equal(o.id, s.id, 'step order');
    assert.ok(['submit','lookup','cancel'].includes(s.action), 'unknown action');
    const now = instant(s.now);
    const r = s.request;
    fields(r,['websiteId','requestKey','input'],'request context shape');
    assert.ok(typeof r.websiteId === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(r.websiteId), 'bounded website scope required');
    assert.ok(typeof r.requestKey === 'string' && r.requestKey.length <= 129,'bounded key context');
    assert.ok(r.input && typeof r.input === 'object' && !Array.isArray(r.input) && Object.keys(r.input).length <= 4 && Object.keys(r.input).every(k => ['kind','propertyId','startDate','endDate'].includes(k)), 'bounded input context');
    assert.ok(!s.committedAfterLoss || s.failure === 'UNAVAILABLE', 'loss seed only on uncertain submission');
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
    else if (typeof r.requestKey !== 'string' || !keyPattern.test(r.requestKey)) requiredError = 'INVALID_ARGUMENT';
    else if (s.action === 'submit' && prior && !isDeepStrictEqual(r.input, prior.input)) requiredError = 'CONFLICT';
    else if (s.action === 'submit' && !prior && !validInput(r.input)) requiredError = 'INVALID_ARGUMENT';
    else if (s.action === 'submit' && !prior && (s.activeCount >= profile.limits.activeIntentsPerWebsite || s.retainedCount >= profile.limits.retainedIdentitiesPerWebsite)) requiredError = 'LIMIT_EXCEEDED';
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
        assert.equal(s.committedAfterLoss.status,'accepted','loss seed accepted only');
        checkInputAssociation(r.input,s.committedAfterLoss.association);
        assert.equal(s.committedAfterLoss.requestKey, r.requestKey, 'reconciled key');
        assert.deepEqual(s.committedAfterLoss.association, s.association, 'reconciled association');
        assert.equal(instant(s.committedAfterLoss.expiresAt), now + TTL_MS, 'fixed deadline');
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
      checkInputAssociation(r.input,o.collection.association);
      assert.equal(instant(o.collection.expiresAt), now + TTL_MS, 'seven day deadline');
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
  assert.ok(Array.isArray(results.observations), 'observations array required');
  if (results.observations.some(o => Object.hasOwn(o, 'context'))) assert.ok(results.observations.every(o => Object.hasOwn(o, 'context')), 'measured context required for every trace');
  const seen = new Set();
  for (const o of results.observations) {
    fields(o, ['id','steps',...(Object.hasOwn(o, 'context') ? ['context'] : [])], 'trace envelope');
    assert.ok(!seen.has(o.id), 'duplicate scenario'); seen.add(o.id);
    const s = fixtures.scenarios.find(s => s.id === o.id);
    assert.ok(s, 'unknown scenario');
    validateProviderTrace(Object.hasOwn(o, 'context') ? measuredProviderScenario(s, o.context) : s, o.steps);
  }
  assert.equal(new Set(fixtures.scenarios.map(s => s.id)).size, fixtures.scenarios.length, 'duplicate fixture scenario');
}

const canonicalJson = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v);
function relationMap() {
  const forward = new Map(), reverse = new Map();
  return (original, measured, label) => {
    const a = canonicalJson(original), b = canonicalJson(measured);
    if (forward.has(a)) assert.equal(b, forward.get(a), label + ' equality changed');
    if (reverse.has(b)) assert.equal(a, reverse.get(b), label + ' distinction erased');
    forward.set(a,b); reverse.set(b,a);
  };
}
// Only measurements are replaceable. Actions and all rejection/coverage
// predicates remain owned by the checked-in canonical scenario.
export function measuredProviderScenario(canonical, context) {
  fields(context, ['evidenceRefs','steps'], 'measured context shape');
  assert.ok(Array.isArray(context.evidenceRefs) && context.evidenceRefs.length > 0 && context.evidenceRefs.length <= 16, 'bounded evidence references');
  for (const ref of context.evidenceRefs) assert.ok(typeof ref === 'string' && ref.length > 0 && ref.length <= 512 && !/[\r\n\x00]/.test(ref), 'bounded evidence reference');
  assert.ok(Array.isArray(context.steps) && context.steps.length === canonical.steps.length, 'measured context step coverage');
  const websites=relationMap(), keys=relationMap(), signatures=relationMap(), associations=relationMap();
  const births=new Map(); let lastTime=-Infinity;
  return { ...canonical, steps: canonical.steps.map((s,i) => {
    const m=context.steps[i];
    fields(m, ['id','now','request','association',...(s.committedAfterLoss ? ['committedAfterLoss'] : []),...(s.workBefore ? ['workBefore'] : [])], 'measured step shape');
    assert.equal(m.id,s.id,'measured step order');
    fields(m.request,['websiteId','requestKey','input'],'measured request shape');
    assert.ok(typeof m.request.websiteId === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(m.request.websiteId), 'bounded measured website');
    websites(s.request.websiteId,m.request.websiteId,'website');
    if (keyPattern.test(s.request.requestKey)) {
      assert.ok(typeof m.request.requestKey === 'string' && keyPattern.test(m.request.requestKey), 'bounded measured key');
      if (s.request.requestKey.length === 128) assert.equal(m.request.requestKey.length,128,'maximum key boundary retained');
    } else assert.equal(m.request.requestKey,s.request.requestKey,'invalid key case retained');
    keys(s.request.requestKey,m.request.requestKey,'request key');
    fields(m.request.input,Object.keys(s.request.input),'measured signature shape');
    for (const [field,value] of Object.entries(m.request.input)) {
      if (field === 'kind' || s.request.input[field] === null) assert.equal(value,s.request.input[field],'signature kind/null retained');
      else if (['startDate','endDate'].includes(field)) assert.ok(date(value),'measured signature date');
      else assert.ok(typeof value === 'string' && value.length <= 2048,'bounded measured signature');
    }
    assert.equal(validInput(m.request.input),validInput(s.request.input),'input validity case retained');
    signatures(s.request.input,m.request.input,'signature');
    if (s.workBefore) { workState(m.workBefore); for (const field of Object.keys(s.workBefore)) assert.equal(m.workBefore[field] > 0,s.workBefore[field] > 0,'work presence case retained'); }
    validateCollection({requestKey:'context',status:'accepted',expiresAt:m.now,association:m.association});
    assert.equal(m.association.provider,s.association.provider,'provider case retained');
    assert.equal(m.association.kind,s.association.kind,'kind case retained');
    if (s.association.startDate === '1970-01-01') {
      assert.equal(m.association.startDate,'1970-01-01','sentinel retained');
      assert.equal(m.association.endDate,'1970-01-01','sentinel retained');
    }
    associations(s.association,m.association,'association');
    for (const field of ['propertyId','startDate','endDate']) {
      if (Object.hasOwn(s.request.input,field) && s.request.input[field] === s.association[field]) {
        assert.equal(m.request.input[field],m.association[field],'signature/association relation retained');
      }
    }
    const now=instant(m.now);
    assert.ok(now >= lastTime,'measured times must be ordered'); lastTime=now;
    const key=identity(s.request.websiteId,s.request.requestKey), birth=births.get(key);
    if (birth) {
      const originalAge=instant(s.now)-birth.canonical;
      const measuredAge=now-birth.measured;
      if (originalAge < TTL_MS) assert.ok(measuredAge < TTL_MS,'pre-expiry case retained');
      else if (originalAge === TTL_MS && s.expected.collection?.status === 'expired' && !birth.expiredSeen) assert.equal(measuredAge,TTL_MS,'exact expiry boundary retained');
      else assert.ok(measuredAge >= TTL_MS,'post-expiry case retained');
      if (s.expected.collection?.status === 'expired') birth.expiredSeen=true;
    }
    if (s.expected.effects.intentCreated === 1 || s.committedAfterLoss) births.set(key,{canonical:instant(s.now),measured:now});
    if (s.committedAfterLoss) {
      validateCollection(m.committedAfterLoss);
      assert.equal(m.committedAfterLoss.status,'accepted','loss seed accepted only');
      assert.equal(m.committedAfterLoss.requestKey,m.request.requestKey,'loss seed key');
      assert.deepEqual(m.committedAfterLoss.association,m.association,'loss seed association');
      assert.equal(instant(m.committedAfterLoss.expiresAt),now+TTL_MS,'loss seed fixed deadline');
    }
    return {...s,now:m.now,request:m.request,association:m.association,...(s.workBefore ? {workBefore:m.workBefore} : {}),...(s.committedAfterLoss ? {committedAfterLoss:m.committedAfterLoss} : {})};
  })};
}
