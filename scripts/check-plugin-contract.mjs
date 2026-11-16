#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { readJson, validateResults } from './plugin-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = resolve(root, 'docs/plugin-contract/v1');
const inventory = readJson(resolve(dir, 'capabilities.json'));
const fixtures = readJson(resolve(dir, 'conformance.json'));
const lock = readJson(resolve(dir, 'skills.lock.json'));
const ops = inventory.operations;
assert.equal(inventory.contractVersion, '1.0.0');
assert.equal(fixtures.evidenceKind, 'synthetic');
assert.equal(new Set(ops.map(o => o.id)).size, ops.length);
const source = readFileSync(resolve(root, 'apps/api/src/mcp.rs'), 'utf8');
const actualTools = [...source.matchAll(/#\[tool\([\s\S]*?\)\]\s*(?:async )?fn (\w+)\(/g)]
  .map(m => m[1]).filter(n => !n.startsWith('hello_world')).sort();
assert.deepEqual(ops.filter(o => o.service === 'htp').map(o => o.binding).sort(), actualTools, 'HTP tool inventory drift');
const annotations = new Map([...source.matchAll(/#\[tool\(([\s\S]*?)\)\]\s*(?:async )?fn (\w+)\(/g)].map(m => [m[2], m[1]]));
for (const op of ops.filter(o => o.service === 'htp')) {
  for (const [field, hint] of [['idempotency', 'idempotent_hint'], ['destructive', 'destructive_hint']]) {
    const match = annotations.get(op.binding).match(new RegExp(hint + '\\s*=\\s*(true|false)'));
    assert.equal(op[field], match[1] === 'true', 'HTP annotation drift: ' + op.binding + ':' + field);
  }
}
for (const op of ops) {
  for (const key of ['id', 'service', 'backend', 'package', 'effect', 'authorization', 'version', 'limits', 'result', 'unsupported', 'source']) assert.ok(op[key], `missing ${key}`);
  assert.ok(['read', 'write'].includes(op.effect));
  assert.ok(['htp', 'seosmith'].includes(op.service));
  if (op.backend === 'gated') assert.ok(op.gate);
}
assert.equal(lock.contractVersion, inventory.contractVersion);
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
  assert.ok(args.length === 2 && args[0] === '--results', 'usage: node scripts/check-plugin-contract.mjs [--results results.json]');
  validateResults(fixtures, readJson(resolve(args[1])), ops);
  console.log('External normalized observations conform (producer provenance/live side effects are not verified).');
}
console.log(`Synthetic offline contract OK: ${ops.length} operations, ${fixtures.scenarios.length} scenarios, 3 host profiles; no live integration tested.`);
