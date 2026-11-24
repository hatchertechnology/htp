import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from '../../apps/web/node_modules/playwright/index.mjs'
const web=`http://127.0.0.1:${process.env.WEB_PORT}`, api=`http://127.0.0.1:${process.env.API_PORT}`, issuer=`http://127.0.0.1:${process.env.ISSUER_PORT}`, site='00000000-0000-0000-0000-000000000003'
const owner=await readFile(`${process.env.FIXTURE_DIR}/owner.token`,'utf8'), other=await readFile(`${process.env.FIXTURE_DIR}/other.token`,'utf8')
async function call(base,path,token,method='GET',body) { const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const text=await r.text();return {status:r.status,body:text?JSON.parse(text):null} }
async function importReport(report,reach) {
 const raw=JSON.stringify(report)
 const imported=await call(api,`/websites/${site}/seo/audits/import`,owner,'POST',{report_json:raw})
 assert.equal(imported.status,200,JSON.stringify(imported)); assert.equal(imported.body.accepted,true); assert.ok(report.findings.length)
 return {report,id:imported.body.delivery_id,reach}
}
const reports=[]
for(const file of ['supabase/tests/fixtures/seosmith-expanded.json','supabase/tests/fixtures/contracts/v2-partial.json']) {
 const report=JSON.parse(await readFile(file,'utf8'))
 reports.push(await importReport(report,report.schema_version===2?'unknown':'1'))
}
// PR75 accepted mismatch: the raw legacy producer claims completeness while
// the receiver derives incomplete crawl coverage from resource_limit.
const legacyMismatch=structuredClone(reports[0].report)
legacyMismatch.request.request_id='00000000-0000-0000-0000-000000000011'
legacyMismatch.stop_reason='resource_limit'
assert.equal(legacyMismatch.coverage_complete,true)
reports.push(await importReport(legacyMismatch,'unknown'))
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[]
page.on('pageerror',e=>errors.push(e.message))
await page.addInitScript(({token})=>localStorage.setItem('sb-127-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:'00000000-0000-0000-0000-000000000001',aud:'authenticated',role:'authenticated'}})),{token:owner})
await page.route('**/*',async route=>{const u=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(u.hostname))return route.abort();if(u.origin===web && (u.pathname.startsWith('/api/google/')||u.pathname.startsWith('/api/bing/')||u.pathname.includes('/insights/')||u.pathname.includes('/search/')||u.pathname.includes('/repository')))return route.fulfill({json:{connected:false,configured:false}});return route.continue()})
try {
 await page.goto(web,{waitUntil:'domcontentloaded'});const picker=page.getByLabel('Inspect a run',{exact:true}); await picker.waitFor({timeout:15000}).catch(async e=>{console.error('dashboard:',(await page.locator('body').innerText()).slice(0,3000),'errors:',errors);throw e})
 for(const {report,id,reach} of reports) {
  await picker.selectOption(id); const panel=page.getByRole('region',{name:'Remediation work'});await panel.locator('label').filter({hasText:'Finding'}).locator('select').waitFor();await panel.locator('label').filter({hasText:'Finding'}).locator('select').selectOption('0')
  const priority = panel.locator('dl[aria-label="Priority inputs"] > div')
  assert.match(await priority.filter({hasText:'Evidence confidence'}).first().innerText(), report.schema_version === 2 ? /high/ : /unknown/)
  const reachText=await priority.filter({hasText:'Affected reach'}).first().innerText()
  assert.match(reachText, reach === 'unknown' ? /unknown/ : new RegExp(`\\b${reach}\\b`))
  if (report.schema_version === 1) assert.match(reachText, reach === 'unknown' ? /crawl coverage incomplete/ : /complete crawl coverage/)
  assert.match(await priority.filter({hasText:'Intended policy'}).first().innerText(), /unavailable/)
  await panel.locator('label').filter({hasText:'Status'}).locator('select').selectOption('done');await panel.locator('label').filter({hasText:'Notes'}).locator('input').fill(`owner schema ${report.schema_version}`);await panel.getByRole('button',{name:'Save work'}).click();await panel.getByText('Work saved. Status does not verify a fix.').waitFor()
  let listed=await call(api,`/websites/${site}/seo/audits/${id}/work?finding_index=0`,owner);assert.equal(listed.status,200);assert.equal(listed.body[0].finding_key,report.findings[0].key);assert.equal(listed.body[0].status,'done');assert.equal(listed.body[0].notes,`owner schema ${report.schema_version}`)
  await panel.locator('label').filter({hasText:'Notes'}).locator('input').fill('edited by owner');await panel.getByRole('button',{name:'Save work'}).click();await panel.getByText('Work saved. Status does not verify a fix.').waitFor()
  await panel.locator('label').filter({hasText:'What was checked'}).locator('input').fill('A user observation');await panel.getByRole('button',{name:'Record attempt'}).click();await panel.getByText('Verification attempt recorded; no finding was automatically resolved.').waitFor()
  listed=await call(api,`/websites/${site}/seo/audits/${id}/work?finding_index=0`,owner);assert.equal(listed.body[0].notes,'edited by owner');assert.equal(listed.body[0].attempts[0].result,'unverified');assert.equal(listed.body[0].status,'done')
  const work=listed.body[0].id
  for(const [method,path,body] of [['GET',`/api/websites/${site}/seo/audits/${id}/work?finding_index=0`,null],['POST',`/api/websites/${site}/seo/audits/${id}/work`,{finding_index:0,work:{status:'open'}}],['POST',`/api/websites/${site}/seo/work/${work}/attempts`,{result:'observed',note:'forged',delivery_id:null}]]) {const denied=await call(web,path,other,method,body);assert.equal(denied.status,403,JSON.stringify(denied))}
  if (report.schema_version === 2) {
   for(let n=0;n<50;n++) {const attempt=await call(api,`/websites/${site}/seo/work/${work}/attempts`,owner,'POST',{delivery_id:null,result:'observed',note:`page attempt ${n}`});assert.equal(attempt.status,200)}
   const first=await call(api,`/websites/${site}/seo/audits/${id}/work?finding_index=0`,owner);assert.equal(first.body[0].attempts.length,50);assert.equal(first.body[0].attempts_more,true)
   const tail=first.body[0].attempts.at(-1),second=await call(api,`/websites/${site}/seo/audits/${id}/work?finding_index=0&before=${encodeURIComponent(tail.created_at)}&before_id=${tail.id}`,owner);assert.equal(second.body[0].attempts.length,1);assert.equal(second.body[0].attempts_more,false);assert.equal(new Set([...first.body[0].attempts,...second.body[0].attempts].map(a=>a.id)).size,51)
   await picker.selectOption(reports[0].id);await page.getByRole('region',{name:'Remediation work'}).locator('label').filter({hasText:'Finding'}).locator('select').waitFor();await picker.selectOption(id)
   await panel.getByRole('button',{name:'Older attempts'}).click();await panel.getByText('Page 2',{exact:true}).waitFor();await panel.getByText('A user observation',{exact:false}).waitFor()
   const notesDraft = panel.getByRole('textbox',{name:'Notes',exact:true})
   const attemptDraft = panel.getByLabel('What was checked')
   await notesDraft.fill('work in progress')
   await attemptDraft.fill('observation in progress')
   const firstHistoryPage = url => url.pathname.endsWith('/' + id + '/work') && !url.searchParams.has('before')
   await page.route(firstHistoryPage, route => route.fulfill({status:503,json:{error:'fixture unavailable'}}))
   await panel.getByRole('button',{name:'Newer attempts'}).click()
   await panel.getByRole('alert').waitFor()
   assert.equal(await notesDraft.inputValue(),'work in progress')
   assert.equal(await attemptDraft.inputValue(),'observation in progress')
   await panel.getByText('Page 2',{exact:true}).waitFor()
   await page.unroute(firstHistoryPage)
   await panel.getByRole('button',{name:'Retry'}).click()
   await panel.getByText('Page 1',{exact:true}).waitFor()
   assert.equal(await notesDraft.inputValue(),'work in progress')
   assert.equal(await attemptDraft.inputValue(),'observation in progress')
   await panel.getByRole('button',{name:'Record attempt'}).click()
   await panel.getByText('Verification attempt recorded; no finding was automatically resolved.').waitFor()
   assert.equal(await notesDraft.inputValue(),'work in progress')
   assert.equal(await attemptDraft.inputValue(),'')
   const attemptsUrl = new URL('/api/websites/' + site + '/seo/work/' + work + '/attempts', web).href
   const requestStarted = page.waitForRequest(attemptsUrl)
   const finishRequest = Promise.withResolvers()
   await page.route(attemptsUrl, async route => {
    await finishRequest.promise
    await route.continue()
   })
   await attemptDraft.fill('submitted observation')
   await panel.getByRole('button',{name:'Record attempt'}).click()
   await requestStarted
   try {
    await attemptDraft.fill('new note while saving')
    await panel.getByRole('combobox',{name:'Result'}).selectOption('observed')
    await panel.getByLabel('Related saved audit ID').fill(id)
   } finally { finishRequest.resolve() }
   await panel.getByText('Verification attempt recorded; no finding was automatically resolved.').waitFor()
   await page.unroute(attemptsUrl)
   assert.equal(await attemptDraft.inputValue(),'new note while saving')
   assert.equal(await panel.getByRole('combobox',{name:'Result'}).inputValue(),'observed')
   assert.equal(await panel.getByLabel('Related saved audit ID').inputValue(),id)
   const afterAttempt = await call(api,`/websites/${site}/seo/audits/${id}/work?finding_index=0`,owner)
   assert.equal(afterAttempt.body[0].attempts[0].note,'submitted observation')
   assert.equal(afterAttempt.body[0].attempts[0].result,'unverified')
   console.log('History pagination, retry and delayed recording preserve independent drafts')
   const findingPicker = panel.getByRole('combobox', {name:'Finding',exact:true})
   const workRead = new URL('/api/websites/' + site + '/seo/audits/' + id + '/work', web)
   const failRead = url => url.pathname === workRead.pathname && url.searchParams.get('finding_index') === '1'
   await page.route(failRead, route => route.fulfill({status:503,json:{error:'fixture unavailable'}}))
   await findingPicker.selectOption('1')
   await panel.getByRole('alert').getByText('Work items could not load.', {exact:false}).waitFor()
   assert.equal(await panel.getByRole('button',{name:'Save work'}).count(),0)
   assert.equal(await panel.getByRole('button',{name:'Record attempt'}).count(),0)
   await page.unroute(failRead)
   await panel.getByRole('button',{name:'Retry'}).click()
   const notes = panel.getByRole('textbox',{name:'Notes',exact:true})
   await notes.waitFor()
   assert.equal(await notes.inputValue(),'')
   assert.equal(await panel.getByRole('combobox',{name:'Status'}).inputValue(),'open')
   console.log('Failed finding read withheld the editor; retry loaded the selected finding')
   console.log('51 real attempts: keyset pages and dashboard older-attempt navigation passed')
  }
  console.log(`schema ${report.schema_version}: receiver import, UI save/edit/attempt, saved finding key, nonowner read/save/attempt denied`)
 }
 assert.deepEqual(errors,[])
} finally {await browser.close()}
