import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from './plugin-contract.mjs';
import { validateProviderTrace, validateProviderResults, validateCollection } from './provider-request-contract.mjs';
const fixtures = readJson(new URL('../docs/plugin-contract/v1.1/conformance.json', import.meta.url));
const results = () => ({contractVersion:'1.1.0',host:'backend',observations:fixtures.scenarios.map(s => ({id:s.id,steps:s.steps.map(t => structuredClone(t.expected))}))});
const trace = id => structuredClone(fixtures.scenarios.find(s => s.id === id));
const check = s => validateProviderTrace(s, s.steps.map(t => t.expected));
test('all synthetic traces satisfy independent semantic assertions for each target', () => {
  for (const host of ['backend','claude','codex','pi']) validateProviderResults(fixtures,{...results(),host});
});
// Mutate both fixture expected and observed: golden equality cannot hide regressions.
for (const [name,id,index,patch,pattern] of [
  ['deadline extension','google.retry.reconcile',1,c => c.expiresAt='2026-11-24T00:00:00.000Z',/cannot revive/],
  ['retry association drift','google.retry.reconcile',1,c => c.association.propertyId='999',/cannot revive/],
  ['key drift','google.retry.reconcile',1,c => c.requestKey='other',/request key/],
  ['withdrawal promises completion','google.withdraw.shared.scheduled.leased',2,c => c.status='cancelled',/intent status/],
  ['withdrawn retry revival','google.withdraw.shared.scheduled.leased',4,c => c.status='accepted',/cannot revive/],
  ['expiry boundary revival','google.expiry.boundary',1,c => c.status='accepted',/cannot revive/],
  ['expired cancel rewrites status','google.expiry.boundary',2,c => c.status='withdrawn',/cannot revive/],
  ['Bing invented date key','bing.rollover.omitted_dates',0,c => c.association.startDate='2026-11-01',/explicit nulls/],
  ['new intent lacks association','google.retry.reconcile',0,c => delete c.association.fqdn,/association shape/],
  ['new intent extends TTL','google.retry.reconcile',0,c => c.expiresAt='2026-11-24T00:00:00.000Z',/seven day/],
  ['unknown fields leak credentials','google.retry.reconcile',0,c => c.accessToken='fixture',/collection shape/],
  ['range beyond bound','google.retry.reconcile',0,c => c.association.endDate='2027-11-15',/date range/],
]) test('reject '+name, () => {
  const s=trace(id); patch(s.steps[index].expected.collection);
  assert.throws(() => check(s),pattern);
});
for (const [name,id,index,field,value,pattern] of [
  ['lookup registers','google.retry.reconcile',2,'intentCreated',1,/cannot register/],
  ['retry duplicates','google.retry.reconcile',1,'intentCreated',1,/duplicate intent/],
  ['retry duplicates job','google.retry.reconcile',1,'collectionJobsCreated',1,/duplicate job/],
  ['withdraw deletes saved data','google.withdraw.shared.scheduled.leased',2,'savedDataDeleted',1,/delete data/],
  ['withdraw cancels shared intent','google.withdraw.shared.scheduled.leased',2,'otherIntentsWithdrawn',1,/shared work/],
  ['withdraw cancels schedule','google.withdraw.shared.scheduled.leased',2,'scheduledWorkCancelled',1,/shared work/],
  ['registration claims provider','google.retry.reconcile',0,'providerClaimsStarted',1,/claim execution/],
  ['renew duplicates shared job','google.new_intent.renewal',1,'collectionJobsCreated',1,/shared job reused/],
  ['uncertainty invents zero writes','uncertain.committed',0,'intentCreated',0,/uncertainty/],
]) test('reject '+name,()=>{const s=trace(id);s.steps[index].expected.effects[field]=value;assert.throws(()=>check(s),pattern);});
for (const id of ['google.conflict','authorization.all_actions','owner_denial.all_actions','caps.new_rejected_existing_available','lookup.cancel.unknown','key.bounds','capability.absent','bing.explicit_range.conflict']) {
  test('reject erased rejection: '+id,()=>{
    const s=trace(id), t=s.steps.find(t=>t.expected.error);
    t.expected.error={code:'UNAVAILABLE'};
    assert.throws(()=>check(s),/required rejection/);
  });
}
test('error payloads and codes bounded independently of golden fixtures',()=>{
  const s=trace('lookup.cancel.unknown');s.steps[0].expected.error={code:'secret token'};
  assert.throws(()=>check(s),/bounded error code/);
  s.steps[0].expected.error={code:'NOT_FOUND',message:'secret'};
  assert.throws(()=>check(s),/bounded error shape/);
});
test('denials cannot disclose a known association',()=>{
  const s=trace('website.key_scope');s.steps[2].expected.collection=structuredClone(s.steps[0].expected.collection);
  assert.throws(()=>check(s),/must not disclose/);
});
test('varied lawful keys/hosts/times validate without golden equality',()=>{
  const s=trace('google.retry.reconcile');
  for (const t of s.steps) {
    t.request.requestKey='natural~key.42'; t.expected.collection.requestKey=t.request.requestKey;
    t.now=new Date(Date.parse(t.now)+86400000).toISOString();
    t.expected.collection.expiresAt=new Date(Date.parse(t.expected.collection.expiresAt)+86400000).toISOString();
    t.association.fqdn='another.test';t.expected.collection.association.fqdn='another.test';
  }
  check(s);
});
test('input object order does not create a conflict',()=>{
  const s=trace('google.retry.reconcile');s.steps[1].request.input=Object.fromEntries(Object.entries(s.steps[1].request.input).reverse());check(s);
});
test('result envelope/version/trace coverage is checked',()=>{
  for (const mutate of [r=>r.observations.pop(),r=>r.observations.push(r.observations[0]),r=>r.observations[1]=r.observations[0],r=>r.contractVersion='1.0.0',r=>r.host='unknown',r=>r.observations[0].steps.pop(),r=>r.secret='fixture']) {
    const r=results();mutate(r);assert.throws(()=>validateProviderResults(fixtures,r));
  }
});
test('invalid calendar dates are rejected',()=>{
  const c=structuredClone(trace('google.retry.reconcile').steps[0].expected.collection);c.association.startDate='2026-02-30';assert.throws(()=>validateCollection(c),/dates/);
});
