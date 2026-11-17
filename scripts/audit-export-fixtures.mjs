// Generates synthetic observations only. Never a backend, host adapter or evidence source.
import { syntheticContext,sha256,exportFixtures } from './audit-export-contract.mjs';
export function syntheticExportTrace(s,c=syntheticContext(s)) {
  const bytes=Buffer.from(c.bytesBase64,'base64'),hash=sha256(bytes),out=[];let now=c.originMs,n=0,state=null,owner=c.owner,exists=true,renamed=false,generation=0;
  for(const [index,t] of s.steps.entries()) {
    now+=(t.afterSeconds??0)*1000;
    const effects={collectionJobsBefore:7,collectionJobsAfter:7,crawlRunsBefore:2,crawlRunsAfter:2};
    const emit=result=>out.push({index,result,effects});
    if(['transferOwner','deleteDelivery','renameWebsite','restart'].includes(t.action)) {
      if(t.action==='transferOwner')owner=c.other;if(t.action==='deleteDelivery')exists=false;if(t.action==='renameWebsite')renamed=true;if(t.action==='restart')generation++;emit(null);continue;
    }
    const allowed=(t.subject==='other'?c.other:c.owner)===owner && exists && !t.website && !t.delivery;
    const expired=!state || state.closed || now>=state.hard || now>=state.idle || generation!==state.generation;
    const offset=t.offset==='end'?bytes.length:t.offset==='pastEnd'?bytes.length+1:t.offset;
    let error=!allowed?'NOT_FOUND':t.action==='detail'&&s.large?'EXPORT_REQUIRED':t.action==='start'&&t.fault?(t.fault==='capacity'?'EXPORT_CAPACITY':'UNAVAILABLE'):t.action==='chunk'&&renamed?'NOT_FOUND':t.action==='chunk'&&expired?'EXPORT_EXPIRED':t.action==='chunk'&&(!Number.isSafeInteger(offset)||offset<0||offset>bytes.length)?'INVALID_ARGUMENT':null;
    if(t.fault==='cancel'){emit({cancelled:true});continue;}
    if(error){emit({isError:true,structuredContent:{code:error,exportVersion:1,message:'Synthetic '+error,...(error==='EXPORT_REQUIRED'?{startTool:'website_audit_export_start_v1',websiteId:c.websiteId,deliveryId:c.deliveryId}:{})}});continue;}
    let r;
    if(t.action==='detail')r=JSON.parse(bytes);
    if(t.action==='start') {
      if(expired)state={id:'fixture-export-'+(++n),hard:now+7200000,idle:now+900000,generation};
      r={version:1,exportId:state.id,websiteId:c.websiteId,deliveryId:c.deliveryId,representation:'htp.audit-detail-json.v1',byteLength:bytes.length,sha256:hash,chunkMaxBytes:262144,expiresAt:new Date(state.hard).toISOString(),idleExpiresAt:new Date(state.idle).toISOString()};
    }
    if(t.action==='chunk') {
      const end=Math.min(bytes.length,offset+262144);state.idle=Math.min(now+900000,state.hard);
      r={version:1,exportId:state.id,offset,dataBase64:bytes.subarray(offset,end).toString('base64'),nextOffset:end,eof:end===bytes.length,byteLength:bytes.length,sha256:hash,idleExpiresAt:new Date(state.idle).toISOString()};
    }
    if(t.action==='close'){if(state)state.closed=true;r={version:1,closed:true};}
    emit({isError:false,structuredContent:r});
  }
  return out;
}
export function syntheticExportResults(host='backend') {
  return {contractVersion:'1.2.0',host,observations:exportFixtures.scenarios.map(s=>({id:s.id,steps:syntheticExportTrace(s)}))};
}
