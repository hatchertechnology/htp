// Synthetic JWTs and loopback-only endpoint; requires the disposable seeded fixture.
import { createHmac } from 'node:crypto'
import assert from 'node:assert/strict'
const u=new URL(process.env.PILOT_FIXTURE_URL ?? 'http://invalid/')
if(process.env.PILOT_FIXTURE !== 'disposable'||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||+u.port<1024||u.pathname!=='/'||u.search||u.hash) throw Error('disposable loopback fixture required')
const key='fixture-only-secret-at-least-thirty-two-bytes', owner='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002', site='00000000-0000-0000-0000-000000000003', site2='00000000-0000-0000-0000-000000000004', form='00000000-0000-0000-0000-000000000005', sub='00000000-0000-0000-0000-000000000008'
function token(role,id){const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url'), body=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role,sub:id,is_anonymous:false,exp:Math.floor(Date.now()/1000)+300});return body+'.'+createHmac('sha256',key).update(body).digest('base64url')}
async function rpc(name,body,role,id){const r=await fetch(new URL('rpc/'+name,u),{method:'POST',headers:{Authorization:'Bearer '+token(role,id),'Content-Type':'application/json'},body:JSON.stringify(body)}); return {status:r.status,body:await r.json()}}
const begin=site=>({p_website_id:site,p_hostname:'www.example.com'}), accept={p_form_id:form,p_submission_id:sub,p_host:'example.com',p_values:{}}
if(process.env.PILOT_FIXTURE_PHASE==='held8') {
 const id='00000000-0000-0000-0000-000000000006'
 const cases=[['begin_form_host_verification',begin(site)],['form_host_challenge',{p_host_id:id}],['save_website_form',{p_website_id:site,p_form_id:null,p_form_key:'held',p_name:'Held',p_fields:[],p_active:false,p_host_ids:[]}],['set_website_form_response_status',{p_website_id:site,p_form_id:form,p_response_id:id,p_status:'reviewed'}],['request_form_recipient',{p_website_id:site,p_form_id:form,p_email:'fixture@example.invalid'}],['disable_form_recipient',{p_website_id:site,p_form_id:form,p_recipient_id:id}],['retry_form_delivery',{p_website_id:site,p_form_id:form,p_job_id:id}],['delete_website_form_response',{p_website_id:site,p_form_id:form,p_response_id:id}]]
 for(const [name,body] of cases) for(const role of ['anon','authenticated']) assert.notEqual((await rpc(name,body,role,owner)).status,200,`held ${role} ${name}`)
 console.log('PASS: all eight owner RPCs held for anon and authenticated');process.exit(0)
}
if(process.env.PILOT_FIXTURE_PHASE==='concurrent') {
 const results=await Promise.all(Array.from({length:20},(_,i)=>rpc('begin_form_host_verification',{p_website_id:site,p_hostname:`race${i}.example.com`},'authenticated',owner)))
 assert.ok(results.every(r=>r.status===200),JSON.stringify(results.map(r=>r.status)))
 assert.equal(new Set(results.map(r=>r.body.host_id)).size,20)
 console.log('PASS: 20 simultaneous same-owner challenge starts');process.exit(0)
}
if(process.env.PILOT_FIXTURE_PHASE==='all8') {
 const host='00000000-0000-0000-0000-000000000006', host2='00000000-0000-0000-0000-000000000009'
 const calls=(s,h)=>[
  ['begin_form_host_verification',{p_website_id:s,p_hostname:'x.example.com'}],
  ['form_host_challenge',{p_host_id:h}],
  ['save_website_form',{p_website_id:s,p_form_id:null,p_form_key:'matrix',p_name:'Matrix',p_fields:[{key:'name',label:'Name',kind:'text',required:false,max_length:100}],p_active:false,p_host_ids:[]}],
  ['set_website_form_response_status',{p_website_id:s,p_form_id:form,p_response_id:host,p_status:'reviewed'}],
  ['request_form_recipient',{p_website_id:s,p_form_id:form,p_email:'fixture@example.invalid'}],
  ['disable_form_recipient',{p_website_id:s,p_form_id:form,p_recipient_id:host}],
  ['retry_form_delivery',{p_website_id:s,p_form_id:form,p_job_id:host}],
  ['delete_website_form_response',{p_website_id:s,p_form_id:form,p_response_id:host}],
 ]
 for(const [name,body] of calls(site,host)) assert.notEqual((await rpc(name,body,'authenticated',other)).status,200,`foreign owner ${name}`)
 for(const [name,body] of calls(site2,host2)) assert.notEqual((await rpc(name,body,'authenticated',owner)).status,200,`unapproved site ${name}`)
 let r=await rpc('begin_form_host_verification',begin(site),'authenticated',owner);assert.equal(r.status,200)
 r=await rpc('form_host_challenge',{p_host_id:r.body.host_id},'authenticated',owner);assert.equal(r.status,200)
 r=await rpc(...calls(site,host)[2],'authenticated',owner);assert.equal(r.status,200)
 const rid='00000000-0000-0000-0000-000000000021'
 r=await rpc('accept_website_form',{...accept,p_submission_id:rid},'service_role',owner);assert.equal(r.body.ok,true)
 const response=await fetch(new URL('website_form_responses?submission_id=eq.'+rid+'&select=id',u),{headers:{Authorization:'Bearer '+token('authenticated',owner)}}).then(x=>x.json());assert.equal(response.length,1)
 r=await rpc('set_website_form_response_status',{p_website_id:site,p_form_id:form,p_response_id:response[0].id,p_status:'reviewed'},'authenticated',owner);assert.equal(r.status,200)
 r=await rpc('request_form_recipient',{p_website_id:site,p_form_id:form,p_email:'fixture@example.invalid'},'authenticated',owner);assert.equal(r.status,200);const recipient=r.body
 const jobs=await fetch(new URL('website_form_delivery_jobs?recipient_id=eq.'+recipient+'&select=id',u),{headers:{Authorization:'Bearer '+token('authenticated',owner)}}).then(x=>x.json());assert.equal(jobs.length,1)
 r=await rpc('retry_form_delivery',{p_website_id:site,p_form_id:form,p_job_id:jobs[0].id},'authenticated',owner);assert.equal(r.status,200);assert.equal(r.body,false)
 r=await rpc('disable_form_recipient',{p_website_id:site,p_form_id:form,p_recipient_id:recipient},'authenticated',owner);assert.equal(r.body,true)
 r=await rpc('delete_website_form_response',{p_website_id:site,p_form_id:form,p_response_id:response[0].id},'authenticated',owner);assert.equal(r.body,true)
 console.log('PASS: all eight owner RPCs reject foreign/unapproved and accept approved owner');process.exit(0)
}
if(process.env.PILOT_FIXTURE_PHASE==='service_acl') {
 for(const method of ['POST','PATCH','DELETE']) {
  const r=await fetch(new URL('forms_pilot_approved_sites?website_id=eq.'+site,u),{method,headers:{Authorization:'Bearer '+token('service_role',owner),'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify({website_id:site2,owner_id:owner})}:method==='PATCH'?{body:JSON.stringify({owner_id:other})}:{})})
  assert.ok(!r.ok,`service role must not ${method} approvals`)
 }
 const r=await rpc('forms_pilot_site_allowed',{p_website_id:site},'service_role',owner);assert.notEqual(r.status,200,'service role cannot call private helper')
 console.log('PASS: service role cannot mutate approvals or call gate directly');process.exit(0)
}
if(process.env.PILOT_FIXTURE_PHASE==='revoked'||process.env.PILOT_FIXTURE_PHASE==='reapproved') {
 const r=await rpc('accept_website_form',accept,'service_role',owner)
 if(process.env.PILOT_FIXTURE_PHASE==='revoked') assert.equal(r.body.error,'form_unavailable')
 else assert.equal(r.body.duplicate,true)
 console.log('PASS: '+process.env.PILOT_FIXTURE_PHASE+' same-ID behavior via PostgREST');process.exit(0)
}
if(process.env.PILOT_FIXTURE_PHASE==='open') {
 let r=await rpc('begin_form_host_verification',begin(site),'authenticated',other);assert.notEqual(r.status,200,'foreign owner')
 r=await rpc('begin_form_host_verification',begin(site2),'authenticated',owner);assert.notEqual(r.status,200,'unapproved own site')
 r=await rpc('begin_form_host_verification',begin(site),'authenticated',owner);assert.equal(r.status,200,'approved owner')
 r=await rpc('form_host_challenge',{p_host_id:'00000000-0000-0000-0000-000000000006'},'authenticated',other);assert.notEqual(r.status,200,'foreign host challenge')
 r=await rpc('form_host_challenge',{p_host_id:'00000000-0000-0000-0000-000000000006'},'authenticated',owner);assert.equal(r.status,200,'approved challenge')
 const save={p_website_id:site2,p_form_id:null,p_form_key:'contact',p_name:'Contact',p_fields:[{key:'name',label:'Name',kind:'text',required:false,max_length:100}],p_active:false,p_host_ids:[]}
 r=await rpc('save_website_form',save,'authenticated',owner);assert.notEqual(r.status,200,'unapproved save')
 r=await rpc('request_form_recipient',{p_website_id:site,p_form_id:form,p_email:'fixture@example.invalid'},'authenticated',owner);assert.notEqual(r.status,200,'recipient remains held')
 r=await rpc('accept_website_form',accept,'service_role',owner);assert.equal(r.body.duplicate,false)
 r=await rpc('accept_website_form',accept,'service_role',owner);assert.equal(r.body.duplicate,true)
 console.log('PASS: owner/site isolation and same-ID acceptance retry via direct PostgREST');process.exit(0)
}
let r=await rpc('begin_form_host_verification',begin(site),'authenticated',owner);assert.notEqual(r.status,200,'hosted-equivalent hold')
r=await rpc('accept_website_form',accept,'authenticated',owner);assert.notEqual(r.status,200,'acceptance is service-only')
console.log('PASS: held owner RPC and service-only acceptance denied via direct PostgREST')
