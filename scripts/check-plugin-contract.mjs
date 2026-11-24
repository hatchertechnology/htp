#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { readJson, validateResults } from './plugin-contract.mjs';
import { profile, validateProviderResults } from './provider-request-contract.mjs';
import { exportProfile, validateExportResults } from './audit-export-contract.mjs';
import { syntheticExportResults } from './audit-export-fixtures.mjs';
import { auditReadProfile, auditReadFixtures, validateAuditReadResults, syntheticAuditReadResults } from './audit-read-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = resolve(root, 'docs/plugin-contract/v1');
const inventory = readJson(resolve(dir, 'capabilities.json'));
const fixtures = readJson(resolve(dir, 'conformance.json'));
// The v1, accepted1.1 and accepted1.2 contract bytes are frozen at the PR base.
// Any correction must ship as a new additive profile, never as an edit here.
const frozenContract = {
  'docs/plugin-contract/v1/capabilities.json': '705661c59702ff1ace3ed7a86d09796c66b60149b561f07832f0d8e28f6499ab',
  'docs/plugin-contract/v1/conformance.json': 'f083ad45141f1fe1b315d736d6e0f4783e826caae2398572ba58da9e03748c18',
  'docs/plugin-contract/v1.1/README.md': '4b3bd0b398ef08cb017af5b4ebdb6bc6e7b73bcc8139d451631640e9e7e5ee57',
  'docs/plugin-contract/v1.1/provider-requests.json': '18b659168f6806cb97991500acaf2a622ab73ce102cc14c4ccd36d57ce5ba6fb',
  'docs/plugin-contract/v1.1/conformance.json': '1e9323230f6c48662d6546255d6461423f231e5b7e4d77d144a8dfe4db3cbf12',
  'docs/plugin-contract/v1.2/README.md': 'e91fafb767dc672450027ad493bfadf729f28685d8dc33fbfb650de9cdf555f1',
  'docs/plugin-contract/v1.2/audit-exports.json': '0efd1c0a8b3684cc35738a218e3745acb3a84dcefe281239fe7c4c5c5d576fb5',
  'docs/plugin-contract/v1.2/conformance.json': 'd589bac111e1010f68da6c9cc8ee403e1939386e1b8e35831916f37ad4051ffe',
};
for (const [path, sha256] of Object.entries(frozenContract)) {
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'), sha256, 'frozen contract drift: ' + path);
}
// Verify the immutable v1 lock against its reviewed revision snapshot, not current source.
const historicalLock = readJson(resolve(dir, 'skills.lock.json'));
assert.equal(createHash('sha256').update(readFileSync(resolve(dir, 'skills.lock.json'))).digest('hex'), '241fbeffd1f9b36f82f7c90869d7ac70a8f3c40e04700b032acc0ed5386b3d83', 'historical v1 lock drift');
for (const f of historicalLock.files) {
  assert.ok(f.path.startsWith('plugins/htp/skills/') && !f.path.includes('..'), 'unsafe historical path');
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'docs/plugin-contract/v1.1/historical-v1-source', f.path))).digest('hex'), f.sha256, 'historical v1 skill snapshot drift: ' + f.path);
}
// Accepted1.1 lock still describes its accepted source, never the current source.
const acceptedProviderLockPath = resolve(root, 'docs/plugin-contract/v1.1/skills.lock.json');
assert.equal(createHash('sha256').update(readFileSync(acceptedProviderLockPath)).digest('hex'), '10d37755a8fa97c887dc2a76b3390606fefc7c421c444fb69d92eea0f08613a9', 'accepted1.1 lock drift');
const providerLock = readJson(acceptedProviderLockPath);
const archiveRoot = resolve(root, 'docs/plugin-contract/v1.2/historical-v1.1-source');
const archiveFiles = readdirSync(archiveRoot, { recursive:true, withFileTypes:true }).filter(f=>f.isFile())
  .map(f=>relative(archiveRoot,resolve(f.parentPath ?? f.path,f.name))).sort();
assert.deepEqual(archiveFiles,providerLock.files.map(f=>f.path).sort(),'accepted1.1 archive inventory');
for (const f of providerLock.files) {
  assert.ok(f.path.startsWith('plugins/htp/skills/') && !f.path.includes('..'), 'unsafe accepted1.1 path');
  assert.equal(createHash('sha256').update(readFileSync(resolve(archiveRoot,f.path))).digest('hex'),f.sha256,'accepted1.1 source snapshot drift: '+f.path);
}
// Accepted1.2 lock is frozen with its archived source; the new1.3 lock is the current source.
const acceptedExportLockPath = resolve(root, 'docs/plugin-contract/v1.2/skills.lock.json');
assert.equal(createHash('sha256').update(readFileSync(acceptedExportLockPath)).digest('hex'), '529ccd4c283dad438b4e88be6d925717ab2ca7c8a30d3258e313b585bddd43ec', 'accepted1.2 lock drift');
const acceptedExportLock = readJson(acceptedExportLockPath);
const acceptedExportArchiveRoot = resolve(root, 'docs/plugin-contract/v1.3/historical-v1.2-source');
const acceptedExportArchiveFiles = readdirSync(acceptedExportArchiveRoot, { recursive:true, withFileTypes:true }).filter(f=>f.isFile())
  .map(f=>relative(acceptedExportArchiveRoot,resolve(f.parentPath ?? f.path,f.name))).sort();
assert.deepEqual(acceptedExportArchiveFiles,acceptedExportLock.files.map(f=>f.path).sort(),'accepted1.2 archive inventory');
for (const f of acceptedExportLock.files) {
  assert.ok(f.path.startsWith('plugins/htp/skills/') && !f.path.includes('..'), 'unsafe accepted1.2 path');
  assert.equal(createHash('sha256').update(readFileSync(resolve(acceptedExportArchiveRoot,f.path))).digest('hex'),f.sha256,'accepted1.2 source snapshot drift: '+f.path);
}
// Current source is explicitly pinned by the new1.3 lock.
const lock = readJson(resolve(root, 'docs/plugin-contract/v1.3/skills.lock.json'));
const providerFixtures = readJson(resolve(root, 'docs/plugin-contract/v1.1/conformance.json'));
const ops = inventory.operations;
assert.equal(inventory.contractVersion, '1.0.0');
assert.equal(fixtures.evidenceKind, 'synthetic');
assert.equal(new Set(ops.map(o => o.id)).size, ops.length);
const source = readFileSync(resolve(root, 'apps/api/src/mcp.rs'), 'utf8');
const actualTools = [...source.matchAll(/#\[tool\([\s\S]*?\)\]\s*(?:async )?fn (\w+)\(/g)]
  .map(m => m[1]).filter(n => !n.startsWith('hello_world')).sort();
// Latest supported HTP inventory is the frozen 1.0.0 set plus every additive
// profile operation. Archived conformance remains checked separately below.
const additiveBindings = [...new Set([
  ...profile.operations.map(op => op.binding),
  ...exportProfile.operations.map(op => op.binding),
  ...auditReadProfile.operations.map(op => op.binding),
])];
const latestHtpBindings = [...new Set([
  ...ops.filter(o => o.service === 'htp').map(o => o.binding),
  ...additiveBindings,
])].sort();
assert.deepEqual(latestHtpBindings, actualTools, 'HTP tool inventory drift');
const annotations = new Map([...source.matchAll(/#\[tool\(([\s\S]*?)\)\]\s*(?:async )?fn (\w+)\(/g)].map(m => [m[2], m[1]]));
for (const op of ops.filter(o => o.service === 'htp')) {
  for (const [field, hint] of [['idempotency', 'idempotent_hint'], ['destructive', 'destructive_hint'], ['effect', 'read_only_hint']]) {
    const match = annotations.get(op.binding).match(new RegExp(hint + '\\s*=\\s*(true|false)'));
    assert.equal(op[field], field === 'effect' ? (match?.[1] === 'true' ? 'read' : 'write') : match?.[1] === 'true', 'HTP annotation drift: ' + op.binding + ':' + field);
  }
}
for (const op of ops) {
  for (const key of ['id', 'service', 'backend', 'package', 'effect', 'authorization', 'version', 'limits', 'result', 'unsupported', 'source']) assert.ok(op[key], `missing ${key}`);
  assert.ok(['read', 'write'].includes(op.effect));
  assert.ok(['htp', 'seosmith'].includes(op.service));
  if (op.backend === 'gated') assert.ok(op.gate);
}
assert.equal(providerLock.contractVersion, profile.contractVersion);
assert.equal(lock.contractVersion, auditReadProfile.contractVersion);
assert.deepEqual(exportProfile.extends,[inventory.contractVersion,profile.contractVersion]);
assert.deepEqual(auditReadProfile.extends,[inventory.contractVersion,profile.contractVersion,exportProfile.contractVersion]);
assert.equal(auditReadProfile.operations.length, 2, 'audit read profile must name exactly the two additive reads');
for (const op of auditReadProfile.operations) {
  assert.ok(['read', 'write'].includes(op.effect));
  assert.equal(op.effect, 'read', 'audit reads must be reads');
  assert.equal(op.collection, false);
  assert.ok(op.authorization && op.id && op.binding && op.result && Array.isArray(op.resultFields) && op.pageField && op.versionField);
}
for (const host of ['backend','claude','codex','pi']) validateAuditReadResults(auditReadFixtures, syntheticAuditReadResults(host));
const exportTools=exportProfile.operations.map(op=>op.binding);
assert.deepEqual(exportTools,['website_audit_export_start_v1','website_audit_export_chunk_v1','website_audit_export_close_v1']);
const implementedExports=actualTools.filter(n=>exportTools.includes(n));
assert.ok(implementedExports.length===0 || implementedExports.length===exportTools.length,'partial export source implementation');
for(const op of exportProfile.operations) {
  assert.equal(op.effect,'read');assert.equal(op.collection,false);assert.ok(op.authorization);
}
for(const host of ['backend','claude','codex','pi'])validateExportResults(syntheticExportResults(host));
assert.equal(profile.extends, inventory.contractVersion);
for (const op of profile.operations) {
  if (!annotations.has(op.binding)) continue; // not deployed/implemented in this baseline
  const hints = annotations.get(op.binding);
  // The existing tool's annotation covers both keyed and legacy calls; preserve it.
  for (const [hint, value] of [['read_only_hint', op.effect === 'read'], ...(op.binding === 'request_website_report' ? [] : [['idempotent_hint', op.idempotency]]), ['destructive_hint', op.destructive]]) {
    assert.equal(hints.match(new RegExp(hint + '\\s*=\\s*(true|false)'))?.[1], String(value), 'provider annotation drift: ' + op.binding + ':' + hint);
  }
}
for (const op of auditReadProfile.operations) {
  if (!annotations.has(op.binding)) continue; // not deployed/implemented in this baseline
  const hints = annotations.get(op.binding);
  for (const [hint, value] of [['read_only_hint', op.effect === 'read'], ['idempotent_hint', op.idempotency], ['destructive_hint', op.destructive]]) {
    assert.equal(hints.match(new RegExp(hint + '\\s*=\\s*(true|false)'))?.[1], String(value), 'audit read annotation drift: ' + op.binding + ':' + hint);
  }
}
for (const host of ['claude','codex','pi']) validateProviderResults(providerFixtures, {
  contractVersion: profile.contractVersion, host, observations: providerFixtures.scenarios.map(s => ({id:s.id, steps:s.steps.map(t => t.expected)}))
});
const skillRoot = resolve(root, lock.source);
const skillFiles = readdirSync(skillRoot, { recursive: true, withFileTypes: true }).filter(f => f.isFile())
  .map(f => relative(root, resolve(f.parentPath ?? f.path, f.name))).sort();
assert.deepEqual(lock.files.map(f => f.path).sort(), skillFiles, 'skill file inventory drift');
for (const f of lock.files) {
  assert.ok(f.path.startsWith('plugins/htp/skills/') && !f.path.includes('..'), 'unsafe lock path');
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, f.path))).digest('hex'), f.sha256, `skill drift: ${f.path}`);
}
for (const host of ['claude', 'codex', 'pi']) {
  const profile = readJson(resolve(dir, `hosts/${host}.json`));
  assert.equal(profile.host, host);
  assert.ok(!/\/(?:home|Users|mnt|tmp)\//.test(JSON.stringify(profile)), 'nonportable absolute host path');
  assert.equal(profile.minimumVersion, null, 'minimum host version requires new acceptance evidence');
  assert.ok(profile.observedVersion && profile.packageStatus && profile.sources.length && profile.gates.length);
  assert.equal(profile.auth.method, 'host-oauth');
  assert.ok(profile.readiness.htp && profile.readiness.seosmith, 'both services must be addressed');
  assert.ok(profile.transports.length > 0);
  for (const key of ['source', 'install', 'upgrade', 'rollback']) assert.ok(profile.distribution[key]);
  validateResults(fixtures, { contractVersion: fixtures.contractVersion, host,
    observations: fixtures.scenarios.map(s => ({ id: s.id, result: s.expected })) }, ops);
}
const args = process.argv.slice(2);
if (args.length) {
  assert.ok(args.length === 2 && ['--results','--provider-results','--audit-read-results'].includes(args[0]), 'usage: node scripts/check-plugin-contract.mjs [--results results.json | --provider-results results.json | --audit-read-results results.json]');
  const external = readJson(resolve(args[1]));
  if (args[0] === '--provider-results') validateProviderResults(providerFixtures, external);
  else if (args[0] === '--audit-read-results') validateAuditReadResults(auditReadFixtures, external);
  else validateResults(fixtures, external, ops);
  if (args[0] === '--provider-results') console.log(external.observations.every(o => Object.hasOwn(o, 'context')) ? 'Measured context supplied for all provider traces; evidence provenance remains an independent acceptance obligation.' : 'Synthetic fixture context selected; this is not measured backend/host acceptance.');
  if (args[0] === '--provider-results') console.log('Provider semantic trace assertions passed. Counters/context require independent measured evidence; provenance and live support are not verified.');
  else if (args[0] === '--audit-read-results') console.log('External normalized audit read transcripts match the synthetic golden contract exactly; outcome must reflect the held producer_unavailable state. This is not varied backend semantic conformance or live producer support evidence.');
  else console.log('External synthetic golden transcripts match exactly; outcome must be unknown. This is not varied backend semantic conformance or live support evidence.');
}
console.log(`Synthetic offline contract OK: ${ops.length} operations, ${fixtures.scenarios.length} scenarios, 3 host profiles; no live integration tested.`);

console.log(`Provider profile ${profile.contractVersion}: ${providerFixtures.scenarios.length} synthetic lifecycle traces; implementation/release gates remain open.`);

console.log(`Audit export profile ${exportProfile.contractVersion}: synthetic semantic assertions only; backend implementation/deployment and three-host current-source parity remain gated.`);

console.log(`Audit read profile ${auditReadProfile.contractVersion}: ${auditReadFixtures.scenarios.length} synthetic stored-read traces; H15 producer, deployment and three-host current-source parity remain gated.`);
