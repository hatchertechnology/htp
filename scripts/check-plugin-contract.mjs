#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { readJson, validateResults } from './plugin-contract.mjs';
import { profile, validateProviderResults } from './provider-request-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = resolve(root, 'docs/plugin-contract/v1');
const inventory = readJson(resolve(dir, 'capabilities.json'));
const fixtures = readJson(resolve(dir, 'conformance.json'));
// Verify the immutable v1 lock against its reviewed revision snapshot, not current source.
const historicalLock = readJson(resolve(dir, 'skills.lock.json'));
assert.equal(createHash('sha256').update(readFileSync(resolve(dir, 'skills.lock.json'))).digest('hex'), '241fbeffd1f9b36f82f7c90869d7ac70a8f3c40e04700b032acc0ed5386b3d83', 'historical v1 lock drift');
for (const f of historicalLock.files) {
  assert.ok(f.path.startsWith('plugins/htp/skills/') && !f.path.includes('..'), 'unsafe historical path');
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'docs/plugin-contract/v1.1/historical-v1-source', f.path))).digest('hex'), f.sha256, 'historical v1 skill snapshot drift: ' + f.path);
}
// Current shared source uses the additive profile lock.
const lock = readJson(resolve(root, 'docs/plugin-contract/v1.1/skills.lock.json'));
const providerFixtures = readJson(resolve(root, 'docs/plugin-contract/v1.1/conformance.json'));
const ops = inventory.operations;
assert.equal(inventory.contractVersion, '1.0.0');
assert.equal(fixtures.evidenceKind, 'synthetic');
assert.equal(new Set(ops.map(o => o.id)).size, ops.length);
const source = readFileSync(resolve(root, 'apps/api/src/mcp.rs'), 'utf8');
const actualTools = [...source.matchAll(/#\[tool\([\s\S]*?\)\]\s*(?:async )?fn (\w+)\(/g)]
  .map(m => m[1]).filter(n => !n.startsWith('hello_world')).sort();
assert.deepEqual(ops.filter(o => o.service === 'htp').map(o => o.binding).sort(), actualTools.filter(n => !profile.operations.some(op => op.binding !== 'request_website_report' && op.binding === n)), 'HTP tool inventory drift');
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
assert.equal(lock.contractVersion, profile.contractVersion);
assert.equal(profile.extends, inventory.contractVersion);
for (const op of profile.operations) {
  if (!annotations.has(op.binding)) continue; // not deployed/implemented in this baseline
  const hints = annotations.get(op.binding);
  // The existing tool's annotation covers both keyed and legacy calls; preserve it.
  for (const [hint, value] of [['read_only_hint', op.effect === 'read'], ...(op.binding === 'request_website_report' ? [] : [['idempotent_hint', op.idempotency]]), ['destructive_hint', op.destructive]]) {
    assert.equal(hints.match(new RegExp(hint + '\\s*=\\s*(true|false)'))?.[1], String(value), 'provider annotation drift: ' + op.binding + ':' + hint);
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
  assert.ok(args.length === 2 && ['--results','--provider-results'].includes(args[0]), 'usage: node scripts/check-plugin-contract.mjs [--results results.json | --provider-results results.json]');
  const external = readJson(resolve(args[1]));
  if (args[0] === '--provider-results') validateProviderResults(providerFixtures, external);
  else validateResults(fixtures, external, ops);
  if (args[0] === '--provider-results') console.log(external.observations.every(o => Object.hasOwn(o, 'context')) ? 'Measured context supplied for all provider traces; evidence provenance remains an independent acceptance obligation.' : 'Synthetic fixture context selected; this is not measured backend/host acceptance.');
  console.log(args[0] === '--provider-results' ? 'Provider semantic trace assertions passed. Counters/context require independent measured evidence; provenance and live support are not verified.' : 'External synthetic golden transcripts match exactly; outcome must be unknown. This is not varied backend semantic conformance or live support evidence.');
}
console.log(`Synthetic offline contract OK: ${ops.length} operations, ${fixtures.scenarios.length} scenarios, 3 host profiles; no live integration tested.`);

console.log(`Provider profile ${profile.contractVersion}: ${providerFixtures.scenarios.length} synthetic lifecycle traces; implementation/release gates remain open.`);
