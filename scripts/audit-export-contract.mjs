// Offline semantic evidence validator. Does not implement exports or execute a host.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readJson } from './plugin-contract.mjs';
export const exportProfile = readJson(new URL('../docs/plugin-contract/v1.2/audit-exports.json',import.meta.url));
export const exportFixtures = readJson(new URL('../docs/plugin-contract/v1.2/conformance.json',import.meta.url));
export const sha256 = b => createHash('sha256').update(b).digest('hex');
const fields = (v, names) => {
  assert.ok(v && typeof v==='object' && !Array.isArray(v),'object required');
  assert.deepEqual(Object.keys(v).sort(),[...names].sort(),'field inventory');
};
const uuid = v => assert.match(v,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,'UUID');
const instant = s => { assert.ok(typeof s==='string' && Number.isFinite(Date.parse(s)),'timestamp'); return Date.parse(s); };
const decode = s => {
  assert.equal(typeof s,'string'); const b=Buffer.from(s,'base64');
  assert.equal(b.toString('base64'),s,'canonical base64'); return b;
};
export function syntheticContext(s) {
  const raw=s.sourceCase==='null' ? null : s.sourceCase==='divergent' ? '{ "schema_version": 1, "old": true }\n' : '{ "schema_version": 1, "title": "é😀" }\n';
  const detail={delivery_id:'00000000-0000-4000-8000-000000000002',scan_at:'2026-11-01T00:00:00Z',received_at:'2026-11-02T00:00:00Z',ingestion_source:'owner',summary:{count:1},report:{schema_version:1,title:'é😀',padding:s.large?'x'.repeat(262144):''},report_json:raw};
  return {evidenceRefs:['synthetic://audit-export/'+s.id],originMs:Date.parse('2026-11-16T00:00:00Z'),websiteId:'00000000-0000-4000-8000-000000000001',deliveryId:detail.delivery_id,owner:'owner-fixture',other:'other-fixture',bytesBase64:Buffer.from(JSON.stringify(detail)).toString('base64')};
}
export function validateExportTrace(s, observations, context=syntheticContext(s)) {
  fields(context,['evidenceRefs','originMs','websiteId','deliveryId','owner','other','bytesBase64']);
  uuid(context.websiteId);uuid(context.deliveryId);
  assert.ok(context.owner!==context.other && [context.owner,context.other].every(v=>typeof v==='string' && v.length>0 && v.length<=128),'distinct bounded subjects');
  assert.ok(Number.isSafeInteger(context.originMs),'clock');
  assert.ok(Array.isArray(context.evidenceRefs) && context.evidenceRefs.length>0 && context.evidenceRefs.length<=16,'independent evidence refs');
  for (const r of context.evidenceRefs) assert.ok(typeof r==='string' && r.length>0 && r.length<=512 && !/[\r\n\x00]/.test(r),'evidence ref');
  const bytes=decode(context.bytesBase64);assert.ok(bytes.length>0 && bytes.length<=4*1024*1024,'offline evidence input bound, not backend report limit');
  const detail=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  for(const k of ['delivery_id','scan_at','received_at','ingestion_source','summary','report','report_json']) assert.ok(Object.hasOwn(detail,k),'complete detail field: '+k);
  assert.equal(detail.delivery_id,context.deliveryId,'source delivery identity');
  assert.ok(detail.report && typeof detail.report==='object','stored report');
  assert.equal(detail.report_json===null,s.sourceCase==='null','raw null coverage retained');
  if(detail.report_json!==null) {
    assert.equal(typeof detail.report_json,'string');
    const raw=JSON.parse(detail.report_json);
    assert.equal(JSON.stringify(raw)!==JSON.stringify(detail.report),true,'raw/stored syntax or value distinction must remain observable');
    if(s.sourceCase==='divergent') assert.notDeepEqual(raw.title,detail.report.title,'legacy divergence case retained');
  }
  assert.equal(bytes.length>262144,s.large,'chunk boundary case retained');
  assert.equal(observations.length,s.steps.length,'step coverage');
  const hash=sha256(bytes), snapshots=new Map(), generations=new Map(); let active=null,now=context.originMs,owner=context.owner,exists=true,renamed=false,generation=0;
  for(let i=0;i<s.steps.length;i++) {
    const step=s.steps[i],o=observations[i];now+=(step.afterSeconds??0)*1000;
    fields(o,['index','result','effects']);assert.equal(o.index,i,'step order');
    fields(o.effects,['collectionJobsBefore','collectionJobsAfter','crawlRunsBefore','crawlRunsAfter']);
    for(const n of Object.values(o.effects)) assert.ok(Number.isSafeInteger(n) && n>=0,'measured counters');
    assert.equal(o.effects.collectionJobsBefore,o.effects.collectionJobsAfter,'export must not collect');
    assert.equal(o.effects.crawlRunsBefore,o.effects.crawlRunsAfter,'export must not crawl');
    if(['transferOwner','deleteDelivery','renameWebsite','restart'].includes(step.action)) {
      assert.equal(o.result,null,'control event has no tool result');
      if(step.action==='transferOwner')owner=context.other;
      if(step.action==='deleteDelivery')exists=false;
      if(step.action==='renameWebsite')renamed=true;
      if(step.action==='restart')generation++;
      continue;
    }
    const subject=step.subject==='other'?context.other:context.owner;
    const allowed=subject===owner && exists && !step.website && !step.delivery;
    const state=active && snapshots.get(active);
    const expired=!state || now>=state.hard || now>=state.idle || state.closed || state.generation!==generation;
    let error=null;
    if(!allowed)error='NOT_FOUND';
    else if(step.action==='detail' && s.large)error='EXPORT_REQUIRED';
    else if(step.action==='start' && step.fault)error=step.fault==='capacity'?'EXPORT_CAPACITY':'UNAVAILABLE';
    else if(step.action==='chunk' && renamed)error='NOT_FOUND';
    else if(step.action==='chunk' && expired)error='EXPORT_EXPIRED';
    const offset=step.offset==='end'?bytes.length:step.offset==='pastEnd'?bytes.length+1:step.offset;
    if(!error && step.action==='chunk' && (!Number.isSafeInteger(offset)||offset<0||offset>bytes.length))error='INVALID_ARGUMENT';
    if(step.fault==='cancel' && o.result?.cancelled===true) {fields(o.result,['cancelled']);continue;}
    fields(o.result,['isError','structuredContent']);
    const r=o.result.structuredContent;
    if(error) {
      assert.equal(o.result.isError,true,'explicit error required');
      fields(r,['code','exportVersion','message',...(error==='EXPORT_REQUIRED'?['startTool','websiteId','deliveryId']:[])]);
      assert.equal(r.code,error,'required rejection');assert.equal(r.exportVersion,1);
      assert.ok(typeof r.message==='string' && r.message.length>0 && r.message.length<=2048,'bounded message');
      if(error==='EXPORT_REQUIRED') {assert.equal(r.startTool,'website_audit_export_start_v1');assert.equal(r.websiteId,context.websiteId);assert.equal(r.deliveryId,context.deliveryId);}
      continue;
    }
    assert.equal(o.result.isError,false,'success');
    if(step.action==='detail') {assert.deepEqual(r,detail,'unchanged complete small inline result');continue;}
    if(step.action==='close') {
      fields(r,exportProfile.closeFields);assert.deepEqual(r,{version:1,closed:true});if(state)state.closed=true;continue;
    }
    assert.equal(r.version,1);
    if(step.action==='start') {
      fields(r,exportProfile.descriptorFields);
      assert.ok(typeof r.exportId==='string' && /^[A-Za-z0-9._~-]{1,256}$/.test(r.exportId),'opaque export identity');
      assert.equal(r.websiteId,context.websiteId);assert.equal(r.deliveryId,context.deliveryId);assert.equal(r.representation,exportProfile.representation);
      assert.equal(r.byteLength,bytes.length);assert.equal(r.sha256,hash);assert.equal(r.chunkMaxBytes,262144);
      const hard=instant(r.expiresAt),idle=instant(r.idleExpiresAt);
      if(!expired) {assert.equal(r.exportId,active,'start replay snapshot');assert.equal(hard,state.hard,'hard deadline immutable');assert.ok(idle>=state.idle && idle<=Math.min(now+900000,hard),'bounded reuse idle');state.idle=idle;}
      else {
        assert.ok(!generations.has(r.exportId),'never reuse old snapshot identity');
        assert.equal(hard,now+7200000,'fixed two-hour hard deadline');assert.equal(idle,now+900000,'initial idle deadline');
        snapshots.set(r.exportId,{hard,idle,closed:false,generation,ranges:[]});generations.set(r.exportId,true);active=r.exportId;
      }
    } else {
      assert.equal(step.action,'chunk');fields(r,exportProfile.chunkFields);
      assert.equal(r.exportId,active,'chunk snapshot identity');assert.equal(r.offset,offset,'byte offset');
      const chunk=decode(r.dataBase64),end=Math.min(offset+262144,bytes.length);
      assert.equal(chunk.length,end-offset,'full bounded chunk');assert.ok(chunk.equals(bytes.subarray(offset,end)),'exact source bytes');
      assert.equal(r.nextOffset,end);assert.equal(r.eof,end===bytes.length,'EOF exact boundary');
      assert.equal(r.byteLength,bytes.length);assert.equal(r.sha256,hash,'immutable snapshot hash');
      assert.equal(instant(r.idleExpiresAt),Math.min(now+900000,state.hard),'idle refresh bounded by hard lifetime');state.idle=instant(r.idleExpiresAt);
      state.ranges.push({offset,bytes:chunk});
      if(r.eof && offset!==bytes.length) {
        let pos=0;const parts=[];
        for(const p of [...state.ranges].sort((a,b)=>a.offset-b.offset)) {if(p.offset===pos){parts.push(p.bytes);pos+=p.bytes.length;}}
        assert.equal(pos,bytes.length,'full reconstruction before completed retrieval');
        const full=Buffer.concat(parts);assert.equal(sha256(full),hash,'reconstructed SHA');assert.ok(full.equals(bytes),'complete immutable detail');
      }
    }
  }
}
export function validateExportResults(results) {
  fields(results,['contractVersion','host','observations']);assert.equal(results.contractVersion,'1.2.0');
  assert.ok(['backend','claude','codex','pi'].includes(results.host),'host');
  assert.ok(Array.isArray(results.observations));assert.equal(results.observations.length,exportFixtures.scenarios.length,'scenario coverage');
  const measured=results.observations.some(o=>Object.hasOwn(o,'context'));
  const seen=new Set();
  for(const o of results.observations) {
    fields(o,['id','steps',...(measured?['context']:[])]);assert.ok(!seen.has(o.id),'duplicate case');seen.add(o.id);
    const s=exportFixtures.scenarios.find(s=>s.id===o.id);assert.ok(s,'known case');
    if(measured)assert.ok(o.context.evidenceRefs.every(r=>!r.startsWith('synthetic:')),'measured reference must identify independent evidence');
    validateExportTrace(s,o.steps,o.context);
  }
  return measured?'measured-context':'synthetic';
}
