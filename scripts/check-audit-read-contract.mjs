#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { auditReadFixtures, syntheticAuditReadResults, validateAuditReadResults } from './audit-read-contract.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--audit-read-results'), 'usage: node scripts/check-audit-read-contract.mjs [--audit-read-results results.json]');
let results = syntheticAuditReadResults();
if (args.length) {
  assert.ok(statSync(args[1]).size <= 1024 * 1024, 'offline evidence file bound');
  results = JSON.parse(readFileSync(args[1], 'utf8'));
}
validateAuditReadResults(auditReadFixtures, results);
console.log('Synthetic offline audit read semantics passed; no backend or host executed. This is fixture consistency, not producer or live support evidence.');
