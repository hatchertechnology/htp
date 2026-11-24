// Disposable local PG17/PostgREST/API stack with signed synthetic identities only.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {chromium} from '../../apps/web/node_modules/playwright/index.mjs'
const web=`http://127.0.0.1:${process.env.WEB_PORT}`,api=`http://127.0.0.1:${process.env.API_PORT}`,site='00000000-0000-0000-0000-000000000003'
const owner=await readFile(`${process.env.FIXTURE_DIR}/owner.token`,'utf8'),other=await readFile(`${process.env.FIXTURE_DIR}/other.token`,'utf8')
async function call(base,path,token,options={}){const r=await fetch(base+path,{...options,headers:{Authorization:`Bearer ${token}`,...options.headers}});return {status:r.status,body:await r.json()}}
const reports=[]
for(const file of ['supabase/tests/fixtures/seosmith-expanded.json','supabase/tests/fixtures/contracts/v2-partial.json']) {
 const raw=await readFile(file,'utf8'),report=JSON.parse(raw),r=await call(api,`/websites/${site}/seo/audits/import`,owner,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({report_json:raw})})
 assert.equal(r.status,200);assert.equal(r.body.accepted,true);const id=r.body.delivery_id,path=`/websites/${site}/seo/audits/${id}`
 const source=await call(api,path,owner),generic=await call(web,`/api${path}`,owner),bounded=await call(web,`/api${path}/dashboard`,owner)
 assert.equal(source.status,200);assert.equal(generic.status,200);assert.equal(bounded.status,200);assert.deepEqual(bounded.body.summary,source.body.summary);assert.deepEqual(bounded.body.summary,generic.body.summary);assert.equal(bounded.body.report_json,raw);assert.deepEqual(bounded.body.report,generic.body.report)
 reports.push({id,raw,summary:source.body.summary,schema:report.schema_version})
}
const browser=await chromium.launch({headless:true});try {
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(({token})=>localStorage.setItem('sb-127-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:'00000000-0000-0000-0000-000000000001',aud:'authenticated',role:'authenticated'}})),{token:owner})
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(u.hostname))return route.abort();if(u.origin===web&&(u.pathname.startsWith('/api/google/')||u.pathname.startsWith('/api/bing/')||u.pathname.includes('/insights/')||u.pathname.includes('/search/')||u.pathname.includes('/repository')))return route.fulfill({json:{connected:false,configured:false}});return route.continue()})
 await page.goto(web,{waitUntil:'domcontentloaded'});const picker=page.getByLabel('Inspect a run',{exact:true});await picker.waitFor({timeout:30000});
 for(const report of reports){await page.waitForFunction(()=>!document.querySelector('select[aria-label="Inspect a run"]')?.disabled);if(await picker.inputValue()!==report.id)await picker.selectOption(report.id);await page.waitForFunction(id=>document.querySelector('select[aria-label="Inspect a run"]')?.value===id,report.id);await page.getByRole('region',{name:'Evidence and coverage'}).waitFor();const checked=page.locator('.seo-summary > div').first();assert.equal((await checked.locator('strong').innerText()).replaceAll(',',''),String(report.summary.pages.checked));const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download run JSON'}).click();const bytes=await readFile(await (await event).path());assert.equal(bytes.toString('utf8'),report.raw);console.log('schema',report.schema,'checked',report.summary.pages.checked,'raw bytes',bytes.length,'sha256',createHash('sha256').update(bytes).digest('hex'))}
 // Browser-origin request using a second signed synthetic identity. The real API/RLS owns the denial.
 for(const report of reports){const result=await page.evaluate(async({site,id,other})=>{const r=await fetch(`/api/websites/${site}/seo/audits/${id}/dashboard`,{headers:{Authorization:`Bearer ${other}`}});return {status:r.status,cache:r.headers.get('cache-control')}},{site,id:report.id,other});assert.ok([403,404].includes(result.status),JSON.stringify(result));assert.match(result.cache,/no-store/)}
 assert.deepEqual(errors,[]);console.log('PASS native PG17/PostgREST/API owner v1/v2 summary and raw parity, browser download and signed nonowner denial')
}finally{await browser.close()}
