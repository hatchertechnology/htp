// Loopback-only integration fixture: real Nuxt page, Supabase SDK, eligibility handler,
// and independently verified synthetic HS256 sessions. No hosted service is contacted.
import assert from 'node:assert/strict'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
const host='127.0.0.1', fixturePort=42901, appPort=42902
const site='10000000-0000-0000-0000-000000000001', owner='20000000-0000-0000-0000-000000000001', other='20000000-0000-0000-0000-000000000002'
const secret='fixture-only-signing-key-never-used-outside-tests', exp=Math.floor(Date.now()/1000)+3600
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url')
function sign(sub) { const body=`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub,role:'authenticated',aud:'authenticated',exp})}`; return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}` }
function verify(auth) { const token=auth?.replace(/^Bearer /,'') || '', parts=token.split('.'); if(parts.length!==3)return null; const sig=createHmac('sha256',secret).update(`${parts[0]}.${parts[1]}`).digest(); const supplied=Buffer.from(parts[2],'base64url'); if(sig.length!==supplied.length || !timingSafeEqual(sig,supplied))return null; try {const claims=JSON.parse(Buffer.from(parts[1],'base64url')); return claims.exp>Date.now()/1000 && [owner,other].includes(claims.sub) ? claims.sub : null} catch{return null} }
const requests=[]
const fixture=createServer((req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Headers','authorization,apikey,content-type,x-client-info'); res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS'); if(req.method==='OPTIONS'){res.writeHead(204).end();return}
 const id=verify(req.headers.authorization), path=new URL(req.url,`http://${host}`).pathname
 requests.push({path,id,method:req.method}); res.setHeader('Content-Type','application/json')
 if(!id){res.writeHead(401).end(JSON.stringify({message:'invalid signed session'}));return}
 if(path==='/auth/v1/user'){res.end(JSON.stringify({id,aud:'authenticated',role:'authenticated',is_anonymous:false}));return}
 if(path===`/websites/${site}`){res.writeHead(id===owner?200:403).end(JSON.stringify(id===owner?{id:site}:{error:'denied'}));return}
 if(path==='/rest/v1/rpc/begin_form_host_verification'){if(id!==owner){res.writeHead(403).end('{}');return} res.end(JSON.stringify({host_id:'fixture-host',txt_name:'_htp-verification.www.example.test',txt_value:'htp-verification='+ 'a'.repeat(64)}));return}
 if(path==='/functions/v1/form-verify'){res.end(JSON.stringify({ok:true}));return}
 res.writeHead(404).end('{}')
})
await new Promise(resolve=>fixture.listen(fixturePort,host,resolve))
let app,browser
async function start(enabled){
 const env={...process.env,NUXT_PUBLIC_SUPABASE_URL:`http://${host}:${fixturePort}`,NUXT_API_BASE_URL:`http://${host}:${fixturePort}`,NUXT_PUBLIC_ROLLOUT_FORMS_VERIFICATION:String(enabled),NUXT_FORMS_PILOT_ENABLED:'true',NUXT_FORMS_PILOT_WEBSITE_ID:site,NUXT_FORMS_PILOT_OWNER_ID:owner}
 app=spawn('./node_modules/.bin/nuxt',['dev','--host',host,'--port',String(appPort)],{env,stdio:['ignore','pipe','pipe']}); let logs=''; app.stdout.on('data',b=>logs+=b);app.stderr.on('data',b=>logs+=b)
 for(let i=0;i<100;i++){if(app.exitCode!==null)throw Error(`Nuxt exited: ${logs}`);try{const r=await fetch(`http://${host}:${appPort}/websites`);if(r.ok)return}catch{};await new Promise(r=>setTimeout(r,300))}throw Error(`Nuxt did not start: ${logs}`)
}
async function stop(){if(!app)return;const p=app;app=null;p.kill('SIGTERM');await new Promise(resolve=>{if(p.exitCode!==null)resolve();else p.once('exit',resolve)})}
async function open(id){
 const page=await browser.newPage(), errors=[]; page.on('pageerror',e=>errors.push(e.message))
 const user={id,aud:'authenticated',role:'authenticated',is_anonymous:false}, token=sign(id)
 await page.addInitScript(({user,token,exp})=>localStorage.setItem('sb-127-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture-refresh',token_type:'bearer',expires_in:3600,expires_at:exp,user})),{user,token,exp})
 await page.route('**/api/websites?*',route=>route.fulfill({json:{items:[{id:site,fqdn:'www.example.test',ga4_property_id:null}],has_more:false}}))
 await page.route('**/api/google/**',route=>route.fulfill({json:{connected:false,configured:false}}))
 await page.route('**/api/bing/**',route=>route.fulfill({json:{connected:false,configured:false}}))
 await page.goto(`http://${host}:${appPort}/websites`); await page.locator('.website-record strong').getByText('www.example.test').waitFor(); return {page,errors}
}
try{
 browser=await chromium.launch({headless:true}); await start(false)
 let {page,errors}=await open(owner); await page.waitForTimeout(300); assert.equal(await page.getByRole('button',{name:'Verify domain',exact:true}).count(),0); assert.equal(requests.filter(x=>x.path.includes('rpc/')||x.path.includes('form-verify')||x.path==='/auth/v1/user').length,0); assert.deepEqual(errors,[]); await page.close(); await stop()
 requests.length=0; await start(true)
 ;({page,errors}=await open(other)); await page.waitForTimeout(500); assert.equal(await page.getByRole('button',{name:'Verify domain',exact:true}).count(),0); assert(requests.some(x=>x.path==='/auth/v1/user'&&x.id===other)); assert(!requests.some(x=>x.path.includes('rpc/')||x.path.includes('form-verify'))); assert.deepEqual(errors,[]); await page.close()
 requests.length=0; ({page,errors}=await open(owner)); await page.getByRole('button',{name:'Verify domain',exact:true}).click(); await page.getByRole('button',{name:'Create DNS challenge'}).click(); await page.getByRole('button',{name:'Verify DNS record'}).click(); await page.getByText('Domain verified.').waitFor()
 assert(requests.some(x=>x.path==='/auth/v1/user'&&x.id===owner)); assert(requests.some(x=>x.path===`/websites/${site}`&&x.id===owner)); assert.deepEqual(requests.filter(x=>x.path.startsWith('/rest/')||x.path.startsWith('/functions/')).map(x=>x.path),['/rest/v1/rpc/begin_form_host_verification','/functions/v1/form-verify']); assert.deepEqual(errors,[]); await page.close()
 console.log('PASS real dashboard: flag off, signed nonowner denied, signed owner create and verify, no unrelated Forms calls')
}finally{await browser?.close();await stop();await new Promise(resolve=>fixture.close(resolve))}
