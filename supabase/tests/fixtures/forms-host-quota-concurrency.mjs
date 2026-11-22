// Requires a freshly seeded disposable PostgREST + PostgreSQL instance.
// The fixed signing key below is synthetic and must never be used elsewhere.
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
const url = new URL(process.env.FORMS_QUOTA_FIXTURE_URL ?? 'http://invalid.invalid')
if (process.env.FORMS_QUOTA_FIXTURE !== 'disposable' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024 || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Explicit disposable loopback fixture required')
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
function token(sub) {
  const header=encode({alg:'HS256',typ:'JWT'}), body=encode({role:'authenticated',sub,is_anonymous:false})
  return `${header}.${body}.${createHmac('sha256','local-test-secret-at-least-32-bytes-long').update(`${header}.${body}`).digest('base64url')}`
}
async function start(owner, site, host) {
  const response=await fetch(new URL('/rpc/begin_form_host_verification',url), {method:'POST',headers:{Authorization:`Bearer ${token(owner)}`,'Content-Type':'application/json'},body:JSON.stringify({p_website_id:site,p_hostname:host}),signal:AbortSignal.timeout(10_000)})
  return {status:response.status,body:await response.json()}
}
const owner1='00000000-0000-0000-0000-000000000001',owner2='00000000-0000-0000-0000-000000000002',owner3='00000000-0000-0000-0000-000000000003',owner4='00000000-0000-0000-0000-000000000004'
const rate=await Promise.all(Array.from({length:80},(_,i)=>start(owner1,`10000000-0000-0000-0000-00000000000${i%2+1}`,`rate${i}.example.com`)))
assert.equal(rate.filter(x=>x.status===200).length,60);assert.equal(rate.filter(x=>x.body.message==='form_host_rate_limited').length,20)
const account=await Promise.all(Array.from({length:10},(_,i)=>start(owner2,`20000000-0000-0000-0000-00000000000${i%2+1}`,`accountnew${i}.example.com`)))
assert.equal(account.filter(x=>x.status===200).length,1);assert.equal(account.filter(x=>x.body.message==='form_host_account_limit').length,9)
const site=await Promise.all(Array.from({length:10},(_,i)=>start(owner3,'30000000-0000-0000-0000-000000000001',`sitenew${i}.example.com`)))
assert.equal(site.filter(x=>x.status===200).length,1);assert.equal(site.filter(x=>x.body.message==='form_host_limit').length,9)
const rotations=await Promise.all(Array.from({length:10},()=>start(owner4,'40000000-0000-0000-0000-000000000001','www.same.example.com')))
assert.equal(rotations.filter(x=>x.status===200).length,10);assert.equal(new Set(rotations.map(x=>x.body.host_id)).size,1)
assert.equal(new Set(rotations.map(x=>createHash('sha256').update(x.body.txt_value.slice('htp-verification='.length)).digest('hex'))).size,10)
const forbidden=await start(owner1,'30000000-0000-0000-0000-000000000001','not-owner.example.com');assert.equal(forbidden.status,403);assert.equal(forbidden.body.message,'Website not found')
const anon=await fetch(new URL('/rpc/begin_form_host_verification',url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_website_id:'30000000-0000-0000-0000-000000000001',p_hostname:'anon.example.com'}),signal:AbortSignal.timeout(10_000)});assert.ok(!anon.ok)
console.log('PASS: concurrent account window, account/site caps, rotation, owner and anonymous boundaries')
