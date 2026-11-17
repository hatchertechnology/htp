#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateExportResults } from './audit-export-contract.mjs';
import { syntheticExportResults } from './audit-export-fixtures.mjs';
const args=process.argv.slice(2);
assert.ok(args.length===0 || (args.length===2 && args[0]==='--export-results'),'usage: node scripts/check-audit-export-contract.mjs [--export-results results.json]');
let results=syntheticExportResults();
if(args.length) {const bytes=readFileSync(args[1]);assert.ok(bytes.length<=32*1024*1024,'offline evidence file bound, not backend report limit');results=JSON.parse(bytes);}
const mode=validateExportResults(results);
console.log(mode==='synthetic'?'Synthetic offline audit export semantics passed; no backend or host executed.':'Measured context semantic assertions passed; evidence provenance, side effects and live support require independent verification.');
