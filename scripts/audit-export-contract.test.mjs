import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,writeFileSync,rmSync,cpSync,mkdirSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportFixtures,syntheticContext,validateExportResults } from './audit-export-contract.mjs';
import { syntheticExportResults,syntheticExportTrace } from './audit-export-fixtures.mjs';
const trace=(r,id)=>r.observations.find(o=>o.id===id).steps;
const payload=(r,id,i)=>trace(r,id)[i].result.structuredContent;
test('all hosts: synthetic full reconstruction, retry, raw/null, access and lifecycle semantics',()=>{
  for(const host of ['backend','claude','codex','pi'])assert.equal(validateExportResults(syntheticExportResults(host)),'synthetic');
});
for(const [name,id,i,mutate] of [
  ['bad source byte','full-retry-eof-close',2,r=>r.dataBase64=Buffer.from('bad').toString('base64')],
  ['hash drift','full-retry-eof-close',4,r=>r.sha256='0'.repeat(64)],
  ['offset drift','full-retry-eof-close',2,r=>r.offset=1],
  ['early EOF','full-retry-eof-close',2,r=>r.eof=true],
  ['retry snapshot drift','full-retry-eof-close',3,r=>r.exportId='different'],
  ['start replay identity','start-reuse',1,r=>r.exportId='different'],
  ['hard deadline extension','start-reuse',1,r=>r.expiresAt='2026-11-16T03:00:00Z'],
  ['idle extension','full-retry-eof-close',2,r=>r.idleExpiresAt='2026-11-16T03:00:00Z'],
  ['owner denial erased','owner-isolation',1,r=>r.code='UNAVAILABLE'],
  ['delivery deletion erased','delivery-revoked',2,r=>r.code='EXPORT_EXPIRED'],
  ['wrong target erased','wrong-target',1,r=>r.code='EXPORT_EXPIRED'],
  ['expiry erased','idle-expiry',2,r=>r.code='UNAVAILABLE'],
  ['hard expiry erased','hard-expiry',9,r=>r.code='UNAVAILABLE'],
  ['capacity erased','capacity',0,r=>r.code='UNAVAILABLE'],
  ['IO erased','io',0,r=>r.code='EXPORT_CAPACITY'],
  ['validation erased','validation',0,r=>r.code='EXPORT_CAPACITY'],
  ['large silently succeeds','full-retry-eof-close',0,r=>r.code='UNAVAILABLE'],
  ['unknown export disclosed','unknown-export',1,r=>r.code='UNAVAILABLE'],
  ['descriptor disclosure','full-retry-eof-close',1,r=>r.path='/private/file'],
])test('reject '+name,()=>{const r=syntheticExportResults();mutate(payload(r,id,i));assert.throws(()=>validateExportResults(r));});
test('reject collection, crawl, case erasure, missing field, fake cancellation success',()=>{
  for(const mutate of [
    r=>trace(r,'legacy-null')[0].effects.collectionJobsAfter++,
    r=>trace(r,'legacy-null')[0].effects.crawlRunsAfter++,
    r=>r.observations.pop(),r=>delete payload(r,'legacy-null',0).idleExpiresAt,
    r=>trace(r,'cancel')[0].result={isError:false,structuredContent:{version:1,exportId:'orphan'}},
    r=>payload(r,'small-inline',0).report_json=null,
  ]) {const r=syntheticExportResults();mutate(r);assert.throws(()=>validateExportResults(r));}
});
function variedResults() {
  return {contractVersion:'1.2.0',host:'backend',observations:exportFixtures.scenarios.map(s=>{
    const c=syntheticContext(s);c.originMs+=123456789;c.websiteId='12345678-1234-4000-8000-000000000001';c.deliveryId='12345678-1234-4000-8000-000000000002';c.owner='observed-owner';c.other='observed-other';c.evidenceRefs=['evidence://isolated-run/source-and-control-ledger'];
    const d=JSON.parse(Buffer.from(c.bytesBase64,'base64'));d.delivery_id=c.deliveryId;d.summary={measured:'varied'};d.report.padding=s.large?'y'.repeat(262160):'varied';if(s.sourceCase==='exact')d.report_json=JSON.stringify(d.report,null,2)+'\n';
    c.bytesBase64=Buffer.from(JSON.stringify(d,null,1)).toString('base64');
    return {id:s.id,context:c,steps:syntheticExportTrace(s,c)};
  })};
}
test('varied measured-context bytes/identities/clocks validate semantically, provenance still external',()=>assert.equal(validateExportResults(variedResults()),'measured-context'));
test('reject mixed context and erased null/boundary cases',()=>{
  for(const mutate of [r=>delete r.observations[0].context,r=>r.observations[1].context.bytesBase64=r.observations[2].context.bytesBase64,r=>r.observations[0].context.bytesBase64=r.observations[1].context.bytesBase64]) {const r=variedResults();mutate(r);assert.throws(()=>validateExportResults(r));}
});
test('CLI labels synthetic vs measured and rejects mutation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'audit-export-'));
  try {
    const path=join(dir,'results.json');
    const run=r=>{writeFileSync(path,JSON.stringify(r));return spawnSync(process.execPath,[fileURLToPath(new URL('./check-audit-export-contract.mjs',import.meta.url)),'--export-results',path],{encoding:'utf8',timeout:10000});};
    assert.match(run(syntheticExportResults()).stdout,/Synthetic/);
    const varied=variedResults();const ok=run(varied);assert.equal(ok.status,0,ok.stderr);assert.match(ok.stdout,/Measured context/);
    payload(varied,'full-retry-eof-close',4).sha256='f'.repeat(64);assert.notEqual(run(varied).status,0);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('denied auth, framework parsing and snapshot-owner isolation cannot return success',()=>{
  for(const mutate of [
    r=>trace(r,'auth-isolation')[0].result={isError:false,structuredContent:{}},
    r=>trace(r,'invalid-offset')[1].result={isError:false,structuredContent:{}},
    r=>payload(r,'owner-isolation',6).code='NOT_FOUND',
    r=>payload(r,'full-retry-eof-close',6).dataBase64='AA==',
    r=>payload(r,'full-retry-eof-close',7).code='EXPORT_EXPIRED',
  ]) {const r=syntheticExportResults();mutate(r);assert.throws(()=>validateExportResults(r));}
});
test('empty EOF does not allow measured context to omit full reconstruction',()=>{
  const r=variedResults(),o=r.observations.find(o=>o.id==='full-retry-eof-close');
  const d=JSON.parse(Buffer.from(o.context.bytesBase64,'base64'));d.report.padding='z'.repeat(600000);d.report_json=JSON.stringify(d.report,null,2)+'\n';
  o.context.bytesBase64=Buffer.from(JSON.stringify(d)).toString('base64');
  o.steps=syntheticExportTrace(exportFixtures.scenarios.find(s=>s.id===o.id),o.context);
  assert.throws(()=>validateExportResults(r),/full reconstruction/);
});

test('canonical checker rejects current skill, accepted1.1 snapshot/lock and source inventory drift',()=>{
  const dir=mkdtempSync(join(tmpdir(),'audit-source-')),root=fileURLToPath(new URL('../',import.meta.url));
  try {
    for(const p of ['scripts','docs/plugin-contract','plugins/htp/skills'])cpSync(join(root,p),join(dir,p),{recursive:true});
    mkdirSync(join(dir,'apps/api/src'),{recursive:true});cpSync(join(root,'apps/api/src/mcp.rs'),join(dir,'apps/api/src/mcp.rs'));
    const run=()=>spawnSync(process.execPath,[join(dir,'scripts/check-plugin-contract.mjs')],{encoding:'utf8',timeout:10000});
    const baseline=run();assert.equal(baseline.status,0,baseline.stderr);
    for(const path of ['plugins/htp/skills/website-management/SKILL.md',
      'docs/plugin-contract/v1.2/historical-v1.1-source/plugins/htp/skills/website-management/SKILL.md',
      'docs/plugin-contract/v1.1/skills.lock.json']) {
      const file=join(dir,path),old=readFileSync(file);writeFileSync(file,Buffer.concat([old,Buffer.from('drift')]));
      assert.notEqual(run().status,0,path);writeFileSync(file,old);
    }
    const file=join(dir,'apps/api/src/mcp.rs');writeFileSync(file,readFileSync(file,'utf8')+'\n#[tool(description="partial")]\nasync fn website_audit_export_start_v1() {}\n');
    assert.notEqual(run().status,0,'partial tool inventory');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
