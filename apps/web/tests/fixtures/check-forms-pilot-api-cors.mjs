// Real local API -> disposable PostgREST/PG, synthetic origins and UUIDs.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { request } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const port=Number(process.env.FORMS_BROWSER_API_PORT)
if (!Number.isInteger(port)||port<1024) throw Error('Disposable API port required')
const dir=await mkdtemp(join(tmpdir(),'forms-pilot-browser-'))
let server,browser
const preflights=[]
try {
 const key=join(dir,'key.pem'),cert=join(dir,'cert.pem')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=fixture.test'],{stdio:'ignore'})
 server=createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>{
  if(req.headers.host?.split(':')[0]!=='api.test'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Fixture</title>');return}
  const upstream=request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1','fly-client-ip':'192.0.2.1'}},response=>{if(req.method==='OPTIONS') preflights.push(response.statusCode);res.writeHead(response.statusCode,response.headers);response.pipe(res)})
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end()});req.pipe(upstream)
 })
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 const tlsPort=server.address().port
 browser=await chromium.launch({args:['--no-proxy-server',`--host-resolver-rules=MAP example.com 127.0.0.1:${tlsPort}, MAP foreign.test 127.0.0.1:${tlsPort}, MAP api.test 127.0.0.1:${tlsPort}`]})
 const page=await browser.newPage({ignoreHTTPSErrors:true})
 const submit=()=>page.evaluate(async()=>{try{const r=await fetch('https://api.test/public/forms/00000000-0000-0000-0000-000000000005',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({submission_id:'00000000-0000-0000-0000-000000000022',name:'Ada'})});return {status:r.status,body:await r.json()}}catch{return {error:'opaque'}}})
 const mode=process.env.FORMS_PILOT_BROWSER_MODE
 if(!['approved','denied'].includes(mode)) throw Error('Explicit pilot browser mode required')
 await page.goto('https://example.com/')
 if(mode==='approved') {assert.deepEqual(await submit(),{status:200,body:{ok:true,duplicate:false}});assert.deepEqual(await submit(),{status:200,body:{ok:true,duplicate:true}});assert.ok(preflights.includes(204),'approved preflight must reach API')}
 else {assert.deepEqual(await submit(),{error:'opaque'});assert.ok(preflights.includes(404),'denied preflight must reach API')}
 await page.goto('https://foreign.test/');assert.deepEqual(await submit(),{error:'opaque'})
 assert.ok(preflights.includes(404),'foreign preflight must be denied')
 console.log(`PASS: pilot-scoped API browser ${mode}, preflight and foreign-origin denial`)
} finally {await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true})}
