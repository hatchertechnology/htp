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

// Exercise the public CLI, including its actual measured-context entry point.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
function measuredResults() {
  const r=results(), shift=30*86400000;
  const key = k => /^[A-Za-z0-9._~-]{1,128}$/.test(k) ? (k.length===128 ? 'y'.repeat(128) : 'pg17~run.'+k) : k;
  const stamp = v => new Date(Date.parse(v)+shift).toISOString();
  const assoc = a => ({...a,fqdn:'measured.example.test',propertyId:typeof a.propertyId==='string' && /^\d+$/.test(a.propertyId) ? '900'+a.propertyId : a.propertyId});
  for (let i=0;i<r.observations.length;i++) {
    const o=r.observations[i], s=fixtures.scenarios[i];
    o.context={evidenceRefs:['evidence://pg17/run-7/transactions-and-wire.json'],steps:s.steps.map(t=>({
      id:t.id, now:stamp(t.now), request:{...structuredClone(t.request),websiteId:t.request.websiteId==='site-a' ? '8f000000-0000-4000-8000-000000000001' : '8f000000-0000-4000-8000-000000000002',requestKey:key(t.request.requestKey),input:{...t.request.input,...(/^\d+$/.test(t.request.input.propertyId ?? '') ? {propertyId:'900'+t.request.input.propertyId} : {})}},association:assoc(t.association),
      ...(t.workBefore ? {workBefore:structuredClone(t.workBefore)} : {}),
      ...(t.committedAfterLoss ? {committedAfterLoss:{...t.committedAfterLoss,requestKey:key(t.committedAfterLoss.requestKey),expiresAt:stamp(t.committedAfterLoss.expiresAt),association:assoc(t.committedAfterLoss.association)}} : {})
    }))};
    let previous=-Infinity;
    for (const t of o.context.steps) { previous=Math.max(previous,Date.parse(t.now)); t.now=new Date(previous).toISOString(); }
    for (const t of o.steps) if (t.collection) t.collection={...t.collection,requestKey:key(t.collection.requestKey),expiresAt:stamp(t.collection.expiresAt),association:assoc(t.collection.association)};
  }
  // Real retry/read measurements need not use the fixture's one-day spacing.
  const t=r.observations.find(o=>o.id==='google.retry.reconcile').context.steps;
  t[1].now=new Date(Date.parse(t[0].now)+15000).toISOString();
  t[2].now=new Date(Date.parse(t[0].now)+17000).toISOString();
  return r;
}
function cli(value) {
  const dir=mkdtempSync(join(tmpdir(),'provider-measured-'));
  try {
    const path=join(dir,'results.json');writeFileSync(path,JSON.stringify(value));
    return spawnSync(process.execPath,[fileURLToPath(new URL('./check-plugin-contract.mjs',import.meta.url)),'--provider-results',path],{encoding:'utf8',timeout:10000});
  } finally {rmSync(dir,{recursive:true,force:true});}
}
test('public CLI accepts measured keys, timestamps, property, FQDN and loss seed',()=>{
  const result=cli(measuredResults());assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/semantic trace assertions passed/);
});
for (const [name,id,mutate,pattern] of [
  ['owner denial result erased','website.key_scope',o=>o.steps[2].error=null,/bounded error shape/],
  ['cap result erased','caps.new_rejected_existing_available',o=>o.steps[1].error=null,/bounded error shape/],
  ['loss reconciliation changed','uncertain.committed',o=>o.steps[1].collection.status='withdrawn',/cannot revive/],
  ['changed conflict erased','google.conflict',o=>o.context.steps[1].request.input={...o.context.steps[0].request.input},/signature distinction erased/],
  ['owner predicate overridden','website.key_scope',o=>o.context.steps[2].owned=true,/measured step shape/],
  ['cap predicate overridden','caps.new_rejected_existing_available',o=>o.context.steps[1].activeCount=0,/measured step shape/],
  ['retry deadline extended','google.retry.reconcile',o=>o.steps[1].collection.expiresAt='2027-01-01T00:00:00.000Z',/cannot revive/],
  ['loss association altered','uncertain.committed',o=>o.context.steps[0].committedAfterLoss.association.fqdn='wrong.test',/loss seed association/],
  ['success seed injected','uncertain.not_committed',o=>o.context.steps[0].committedAfterLoss={},/measured step shape/],
  ['retry key substituted','google.retry.reconcile',o=>o.context.steps[1].request.requestKey='another-key',/request key equality/],
  ['website denial collapsed','website.key_scope',o=>o.context.steps[1].request.websiteId=o.context.steps[0].request.websiteId,/website distinction/],
  ['shared association changed','google.new_intent.renewal',o=>o.context.steps[1].association.fqdn='changed.test',/association equality/],
  ['expiry boundary moved','google.expiry.boundary',o=>o.context.steps[1].now=new Date(Date.parse(o.context.steps[1].now)+1).toISOString(),/exact expiry boundary/],
  ['invalid calendar timestamp','google.retry.reconcile',o=>o.context.steps[0].now='2026-02-30T00:00:00.000Z',/invalid timestamp/],
  ['unbounded evidence ref','google.retry.reconcile',o=>o.context.evidenceRefs=['x'.repeat(513)],/bounded evidence/],
  ['missing context step','google.retry.reconcile',o=>o.context.steps.pop(),/context step coverage/],
  ['canonical action overridden','google.withdraw.shared.scheduled.leased',o=>o.context.steps[2].action='lookup',/measured step shape/],
]) test('public CLI rejects measured '+name,()=>{
  const r=measuredResults();mutate(r.observations.find(o=>o.id===id));
  const result=cli(r);assert.notEqual(result.status,0);assert.match(result.stderr,pattern);
});

test('public CLI rejects mixing measured and synthetic context',()=>{
  const r=measuredResults();delete r.observations[1].context;
  const result=cli(r);assert.notEqual(result.status,0);assert.match(result.stderr,/context required for every trace/);
});

test('public CLI bounds entire measured envelope before parsing',()=>{
  const r=measuredResults();r.observations[0].context.evidenceRefs=['x'.repeat(1024*1024)];
  const result=cli(r);assert.notEqual(result.status,0);assert.match(result.stderr,/exceeds 1 MiB/);
});

for (const [name,patch] of [
  ['kind',a=>a.kind='search'], ['property',a=>a.propertyId='999'],
  ['range',a=>a.startDate='2026-11-02'],
]) test('independent input/job association binding: '+name,()=>{
  const s=trace('google.retry.reconcile');patch(s.steps[0].association);patch(s.steps[0].expected.collection.association);
  assert.throws(()=>check(s),/input\/job association mismatch/);
});
test('invalid range is rejected without a fixture flag',()=>{
  const s=trace('google.retry.reconcile');s.steps[0].request.input.startDate='2026-11-30';
  assert.throws(()=>check(s),/bounded error shape/);
});
test('invalid range fixture contains an independently invalid range',()=>{
  const s=trace('input.range.invalid');assert.ok(s.steps[0].request.input.startDate>s.steps[0].request.input.endDate);
  assert.equal(Object.hasOwn(s.steps[0],'invalidInput'),false);check(s);
});
for (const field of ['leasedClaims','scheduledJobs','activeOtherIntents','savedSnapshots']) test('withdrawal preserves measured '+field,()=>{
  const s=trace('google.withdraw.shared.scheduled.leased');s.steps[2].expected.workAfter[field]--;
  assert.throws(()=>check(s),/preserve measured/);
});
test('last keyed withdrawal retains leased work, schedule and snapshots',()=>{
  const s=trace('google.withdraw.shared.scheduled.leased');const t=s.steps.at(-1);
  assert.equal(t.workBefore.activeOtherIntents,0);assert.ok(t.workBefore.leasedClaims>0 && t.workBefore.scheduledJobs>0 && t.workBefore.savedSnapshots>0);check(s);
});
test('successful submit cannot inject a reconciliation seed',()=>{
  const s=trace('google.retry.reconcile');s.steps[0].committedAfterLoss=structuredClone(s.steps[0].expected.collection);
  assert.throws(()=>check(s),/loss seed only/);
});
test('bounded request shape rejects extra context fields',()=>{
  const s=trace('google.retry.reconcile');s.steps[0].request.extra='fixture';assert.throws(()=>check(s),/request context shape/);
});
test('public CLI rejects measured invalid-range case becoming valid',()=>{
  const r=measuredResults(),o=r.observations.find(o=>o.id==='input.range.invalid');
  o.context.steps[0].request.input.startDate='2026-11-01';o.context.steps[0].request.input.endDate='2026-11-15';
  const result=cli(r);assert.notEqual(result.status,0);assert.match(result.stderr,/input validity case retained/);
});
test('public CLI rejects cancelling an already measured lease',()=>{
  const r=measuredResults(),o=r.observations.find(o=>o.id==='google.withdraw.shared.scheduled.leased');o.steps.at(-1).workAfter.leasedClaims=0;
  const result=cli(r);assert.notEqual(result.status,0);assert.match(result.stderr,/preserve measured/);
});

test('business_locations nonempty source is rejected, not silently normalized',()=>{
  const s=trace('google.undated.omitted.business_locations');
  for (const t of s.steps) {
    t.request.input.propertyId='123';t.association.propertyId='123';
    if (t.expected.collection) t.expected.collection.association.propertyId='123';
  }
  assert.throws(()=>check(s),/bounded error shape|association requires empty/);
});
test('business_locations new-invalid versus existing-conflict order is defined',()=>{
  const s=trace('google.business_locations.property_constraint');
  assert.equal(s.steps[0].expected.error.code,'INVALID_ARGUMENT');
  assert.equal(s.steps[2].expected.error.code,'CONFLICT');check(s);
});
test('public CLI cannot erase the nonempty business_locations rejection',()=>{
  const r=measuredResults(),o=r.observations.find(o=>o.id==='google.business_locations.property_constraint');
  o.context.steps[0].request.input.propertyId='';
  const result=cli(r);assert.notEqual(result.status,0);assert.match(result.stderr,/input validity case retained/);
});
