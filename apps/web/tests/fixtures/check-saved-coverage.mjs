// Normal dashboard entry with synthetic saved detail responses; no external traffic or writes.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const origin = 'http://127.0.0.1:3105'
const files = ['seosmith-expanded.json', 'contracts/v2-partial.json', 'contracts/v2-truncated.json']
const reports = await Promise.all(files.map(async f => JSON.parse(await readFile(new URL(`../../../../supabase/tests/fixtures/${f}`, import.meta.url)))))
reports.push({...reports[1], evidence_contract:{...reports[1].evidence_contract, version:99}})
const ids = ['00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000007']
const site = '00000000-0000-0000-0000-000000000003', user = '00000000-0000-0000-0000-000000000001'
const time = '2026-11-01T00:00:00Z', exp = Math.floor(Date.now()/1000)+3600
const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:user,exp})).toString('base64url')}.fake`
const details = reports.map((report,i) => ({ delivery_id:ids[i], scan_at:`2026-11-0${4-i}T00:00:00Z`, received_at:time, ingestion_source:i===0?'import':'worker', summary:{ schema_version:report.schema_version, summary_version:3, engine_version:report.engine_version, ruleset_version:report.ruleset_version, started_at:report.started_at, finished_at:report.finished_at, outcome:report.outcome, stop_reason:report.stop_reason, coverage_complete:report.coverage_complete, crawl_coverage_complete:report.coverage_complete, evaluation_coverage_complete:report.evidence_contract?.evaluation_coverage_complete ?? null, comparison_key:'fixture', pages:{checked:report.pages.length,html:0,images:0,http_errors:0,fetch_errors:0,blocked:0}, findings:report.findings.length, severities:{critical:0,alert:0,warning:0}, rules:{} }, report }))
const browser = await chromium.launch({headless:true})
const page = await browser.newPage({viewport:{width:390,height:844}}), errors=[], calls=[]
page.on('pageerror', e=>errors.push(e.message))
await page.addInitScript(({token,exp,user})=>localStorage.setItem('sb-raxuvdbdfmmtpqjcafcq-auth-token',JSON.stringify({access_token:token,refresh_token:'fake',token_type:'bearer',expires_in:3600,expires_at:exp,user:{id:user,aud:'authenticated',role:'authenticated'}})),{token,exp,user})
await page.route('**/*', async route => {
 const req=route.request(), u=new URL(req.url()), path=u.pathname, json=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)})
 if (u.hostname==='raxuvdbdfmmtpqjcafcq.supabase.co' && path.includes('/auth/v1/')) return json({id:user,aud:'authenticated'})
 if (u.hostname!=='127.0.0.1') { calls.push(`BLOCKED ${req.method()} ${u.hostname}${path}`); return route.abort() }
 if (path.startsWith('/api/')) {
   calls.push(`${req.method()} ${path}`)
   if(req.method()!=='GET') { calls.push(`ABORTED ${req.method()} ${path}`); return route.abort() }
   if(path==='/api/websites') return json({items:[{id:site,fqdn:'example.com'}],has_more:false})
   if(path===`/api/websites/${site}/seo/audits`) return json({items:details.map(({report,...run})=>run),has_more:false,next_cursor:null})
   const match=path.match(/\/seo\/audits\/([^/]+)$/); if(match) return json(details.find(d=>d.delivery_id===match[1]))
   return json({connected:false,configured:false})
 }
 return route.continue()
})
try {
 await page.goto(origin, {waitUntil:'domcontentloaded'})
 const panel=page.getByRole('region',{name:'Evidence and coverage'})
 await panel.getByText(/unavailable or unsupported/).waitFor()
 assert.match(await panel.innerText(), /Evaluation coverage: Unknown/)
 assert.match(await panel.innerText(), /Imported report/)
 await page.getByLabel('Inspect a run', {exact:true}).selectOption(ids[1])
 await panel.getByRole('table',{name:'Rule coverage in the saved report'}).waitFor()
 assert.match(await panel.innerText(), /Crawl coverage: Partial/)
 assert.match(await panel.innerText(), /legacy not instrumented: 4/)
 assert.match(await panel.innerText(), /unauthenticated SHA-256 digest/)
 await page.getByLabel('Inspect a run', {exact:true}).selectOption(ids[2])
 await panel.getByText(/observations were omitted/).waitFor()
 assert.match(await panel.innerText(), /contract limit: 872/)
 await page.getByLabel('Inspect a run', {exact:true}).selectOption(ids[3])
 await panel.getByText(/unavailable or unsupported/).waitFor()
 assert.equal(await panel.getByRole('table').count(), 0)
 assert.match(await panel.innerText(), /Evaluation coverage: Unknown/)
 await page.getByLabel('Inspect a run', {exact:true}).selectOption(ids[2])
 await panel.getByText(/observations were omitted/).waitFor()
 await page.screenshot({path:'/tmp/htp-saved-coverage-mobile.png',fullPage:true})
 assert.deepEqual(errors,[])
 assert.ok(calls.some(c=>c.endsWith(`/seo/audits/${ids[2]}`)))
 assert.ok(!calls.some(c=>c.startsWith('BLOCKED')),calls.join('\n'))
 assert.ok(calls.filter(c=>/^(POST|PUT|PATCH|DELETE) /.test(c)).every(c=>calls.includes(`ABORTED ${c}`)))
 assert.ok(!calls.some(c=>/^(POST|PUT|PATCH|DELETE) .*\/seo\/audits/.test(c)))
 console.log('PASS: normal dashboard v1, partial v2, truncated v2 and unsupported contract; audit GETs only; unrelated POST attempts aborted; no external traffic')
 console.log(calls.join('\n'))
} finally { await browser.close() }
