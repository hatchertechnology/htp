#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { parityReadFixtures, syntheticParityReadResults, validateParityReadResults } from './parity-read-contract.mjs';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--parity-read-results'), 'usage: node scripts/check-parity-read-contract.mjs [--parity-read-results results.json]');
let results = syntheticParityReadResults();
if (args.length) {
  assert.ok(statSync(args[1]).size <= 1024 * 1024, 'offline evidence file bound');
  results = JSON.parse(readFileSync(args[1], 'utf8'));
}
validateParityReadResults(parityReadFixtures, results);
console.log('Synthetic offline parity read semantics passed; no backend or host executed. This is fixture consistency, not rollout or live support evidence.');
