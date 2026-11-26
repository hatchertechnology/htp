// Mocked authentication and data; run against a local preview only.
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
const origin = process.env.HTP_TEST_ORIGIN || 'http://127.0.0.1:3105'
const target = new URL(origin)
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('This test only runs against loopback HTTP.')
const mode = process.env.HTP_COMPARISON_MODE || 'off'
const calls = [], auditRequests = [], importBodies = []
let delaySource = false, releaseSource, sourceRequested
const sourceRequest = new Promise(resolve => { sourceRequested = resolve })
const sourceRelease = new Promise(resolve => { releaseSource = resolve })
const browser=await chromium.launch({headless:true}), page=await browser.newPage(), errors=[]
page.on('pageerror',e=>errors.push(e.message))
const id='00000000-0000-0000-0000-000000000003', a='00000000-0000-0000-0000-000000000004', b='00000000-0000-0000-0000-000000000005', c='00000000-0000-0000-0000-00000000000f', src='00000000-0000-0000-0000-000000000006', site2='00000000-0000-0000-0000-00000000000b', exp=Math.floor(Date.now()/1000)+3600
const token=`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',exp})).toString('base64url')}.fake`
await page.addInitScript(({token,exp})=>localStorage.setItem('sb-raxuvdbdfmmtpqjcafcq-auth-token',JSON.stringify({access_token:token,refresh_token:'fake',token_type:'bearer',expires_in:3600,expires_at:exp,user:{id:'00000000-0000-0000-0000-000000000001',aud:'authenticated',role:'authenticated'}})),{token,exp})
const report={schema_version:1,engine_version:'0.2.0',ruleset_version:'2026-11-01.1',outcome:'completed',stop_reason:'frontier_exhausted',coverage_complete:true,pages:[{url:'https://example.com/',status:200,content_type:'text/html',error:null,is_resource:false,blocked_by_robots:false,flags:[],extraction_truncated:false}],findings:[]}
// The schema-4 report the dashboard and s15-metadata-2 use. Entity ids are SEOsmith's: sha256('seosmith-entity-v1\npage\n' + url).
const entity=url=>'sha256:'+createHash('sha256').update(`seosmith-entity-v1\npage\n${url}`).digest('hex')
const report4={schema_version:4,engine_version:'0.2.0',ruleset_version:'2026-11-01.1',outcome:'completed',stop_reason:'frontier_exhausted',coverage_complete:true,pages:report.pages,findings:[],evidence_contract:{version:1,truncated:false,evaluation_coverage_complete:false,evaluations:[{entity_id:entity('https://example.com/'),rule:'missing_title',outcome:'pass',unknown_reason:null}],coverage:[{rule:'missing_title',unknown:0,unknown_reasons:{}},{rule:'missing_description',unknown:1,unknown_reasons:{legacy_not_instrumented:1}}]}}
const snapshot={id:'00000000-0000-0000-0000-000000000007',fqdn:'old.example.com',created_at:'saved comparison',semantics:'s15-metadata-1',import_id:src,delivery_id:a,unmodified_v1_asserted:true}
const snapshot4={...snapshot,id:'00000000-0000-0000-0000-00000000000c',created_at:'schema four comparison',semantics:'s15-metadata-2'}
const unsupported={...snapshot,id:'00000000-0000-0000-0000-000000000008',created_at:'future comparison',semantics:'future-semantics'}
const source={id:src,fqdn:'example.com',source_text:'url,rule,state\nhttps://example.com/,missing_title,absent\n',metadata:{filename:'example.csv'},source_sha256:'x'}
const legacySource={id:'00000000-0000-0000-0000-00000000000a',fqdn:'legacy.example.com',source_text:'url,rule,state\nhttps://legacy.example.com/,missing_title,absent\n',metadata:{filename:'legacy.csv',provenance:'Legacy free-text note: parser and rendering differences not assessed.'},source_sha256:'legacy'}
await page.route('**/*',async route=>{
 const u=new URL(route.request().url()), path=u.pathname, json=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)})
 if(u.hostname==='raxuvdbdfmmtpqjcafcq.supabase.co'){
   if(path.includes('/auth/v1/')) return json({id:'00000000-0000-0000-0000-000000000001',aud:'authenticated'})
   const body=route.request().postDataJSON()||{}
   if(path.includes('/rest/v1/rpc/')) calls.push(path.split('/').pop())
   if(path.endsWith('/independent_audit_history')) {
     if (delaySource && body.p_id) { sourceRequested(); await sourceRelease; return route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({message: 'stale source failure'})}) }
     if (body.p_website_id === site2) return json(body.p_id ? null : {items:[],next_cursor:null})
     return json(body.p_id?(body.p_id === legacySource.id ? legacySource : source):{items:[source,legacySource],next_cursor:null})
   }
   if(path.endsWith('/independent_comparison_history')) return json(body.p_website_id === site2 ? {items:[],next_cursor:null} : {items:[snapshot,snapshot4,unsupported],next_cursor:null})
   if(path.endsWith('/independent_comparison_detail')) return json({comparison:[unsupported,snapshot4].find(c => c.id === body.p_comparison_id) || snapshot,source,seosmith:{fqdn:'example.com',report:body.p_comparison_id === snapshot4.id ? report4 : report,report_json:'original report',sha256:'abc'}})
   if(path.endsWith('/import_independent_audit')) { importBodies.push(body); return json({id:'00000000-0000-0000-0000-000000000009',source_sha256:'x',created_at:'now'}) }
   if(path.endsWith('/independent_evidence_fingerprint')) return json('fingerprint')
   return json(null)
 }
 if(path==='/api/websites') return json({items:[{id,fqdn:'example.com'},{id:site2,fqdn:'second.example.com'}],has_more:false})
 if(path.startsWith(`/api/websites/${id}/seo/audits`)) auditRequests.push(path)
 if(path===`/api/websites/${id}/seo/audits`) return json({items:[{delivery_id:a,scan_at:'run one',summary:{outcome:'completed'}},{delivery_id:b,scan_at:'run two',summary:{outcome:'completed'}},{delivery_id:c,scan_at:'run three',summary:{outcome:'completed'}}],next_cursor:null})
 if(path===`/api/websites/${id}/seo/audits/${c}`) return json({report})
 if(path.startsWith(`/api/websites/${id}/seo/audits/`)) return json({report:report4})
 if(path.startsWith('/api/google/')||path.startsWith('/api/bing/')) return json({connected:false,configured:false})
 return route.continue()
})

const dashboardAudit = page.waitForResponse(response => response.url().includes(`/seo/audits/${a}`))
await page.goto(`${origin}/`)
await dashboardAudit
auditRequests.length = 0
const link = page.getByRole('link', { name: 'Independent audit comparisons' })
if (mode === 'off') {
  if (await link.count()) throw Error('off mode exposes dashboard link')
  await page.goto(`${origin}/independent-audits`)
  await page.getByText('Independent audit comparisons are not available yet.').waitFor()
  if (calls.length) throw Error(`off mode issued RPCs: ${calls}`)
} else {
  await link.click()
  await page.getByRole('button',{name:/example.csv/}).waitFor({timeout:20000})
  await page.goto(`${origin}/independent-audits`)
  await page.getByRole('button',{name:/example.csv/}).waitFor({timeout:20000})
  await page.getByRole('button',{name:/example.csv/}).click()
  await page.getByText('Unknown / not provided').first().waitFor()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button',{name:'Download original CSV'}).click()
  await downloadPromise
  await page.getByRole('button',{name:/saved comparison/}).click()
  await page.getByRole('table').waitFor()
  await page.getByText(/Compared SEOsmith report: example\.com/).waitFor()
  if (mode === 'read-only' || mode === 'both') {
    await page.getByText(/Read-only: showing/).waitFor()
    // The page select is gone; the header context bar is the only site selector.
    const websiteSelect = page.getByLabel('Select website')
    await websiteSelect.selectOption(site2)
    await page.getByText('No independent imports found.').waitFor()
    if (await page.getByText(/Compared SEOsmith report/).count()) throw Error('website switch retained prior report metadata')
    await websiteSelect.selectOption(id)
    await page.getByRole('button',{name:/example.csv/}).waitFor()
    await page.getByRole('button',{name:/schema four comparison/}).click()
    await page.getByRole('table').waitFor()
    await page.getByText(/1 agreement/).first().waitFor()
    await page.getByRole('table').getByText('absent',{exact:true}).first().waitFor()
    await page.getByRole('button',{name:/saved comparison/}).click()
    await page.getByRole('table').waitFor()
    await page.getByText(/Compared SEOsmith report: example\.com/).waitFor()
    await page.getByRole('button',{name:/legacy.csv/}).click()
    await page.getByText('Legacy source note').waitFor()
    await page.getByText('Legacy free-text note: parser and rendering differences not assessed.').waitFor()
    if (await page.getByText(/Compared SEOsmith report/).count()) throw Error('legacy import selection retained prior report metadata')
    delaySource = true
    await page.getByRole('button',{name:/example.csv/}).click()
    await sourceRequest
    await page.getByRole('button',{name:/saved comparison/}).click()
    await page.getByRole('table').waitFor()
    const rejectedResponse = page.waitForResponse(response => response.url().endsWith('/independent_audit_history') && response.status() === 500)
    releaseSource()
    await rejectedResponse
    await page.waitForTimeout(100)
    if (await page.getByText('stale source failure').count()) throw Error('stale selection failure shown after opening snapshot')
    await page.getByRole('table').waitFor()
    await page.getByRole('button',{name:/example.csv/}).click()
    await page.getByRole('alert').getByText('stale source failure').waitFor()
    if (await page.getByText(/Compared SEOsmith report/).count()) throw Error('failed import selection retained prior report metadata')
    delaySource = false
    await page.getByRole('button',{name:/example.csv/}).click()
    await page.getByText(/Original file: example\.csv/).waitFor()
    if (await page.getByText(/Compared SEOsmith report/).count()) throw Error('import selection retained prior report metadata')
    await page.getByRole('button',{name:/saved comparison/}).click()
    await page.getByRole('table').waitFor()
    for (const name of ['Save import', 'Delete independent evidence', 'Save comparison', 'Export all independent evidence']) {
      if (await page.getByRole('button',{name,exact:true}).count()) throw Error(`read-only exposes ${name}`)
    }
    // The page's own website select was removed (the header select lives outside main.page-shell).
    if (await page.locator('main.page-shell input[type=file], main.page-shell textarea, main.page-shell input[type=checkbox], main.page-shell select').count() !== 0) throw Error('read-only exposes editing controls')
    await page.getByRole('button',{name:/future comparison/}).click()
    await page.getByRole('alert').getByText(/unsupported semantics/).waitFor()
    const allowed = ['independent_audit_history','independent_comparison_history','independent_comparison_detail']
    if (auditRequests.length) throw Error(`read-only requested SEOsmith audits: ${auditRequests}`)
    if (calls.some(name => !allowed.includes(name))) throw Error(`unexpected RPC: ${calls}`)
  } else {
    // Saving pins the current semantics, so an older s15-metadata-1 snapshot replays without a Save button.
    if (await page.getByRole('button',{name:'Save comparison'}).count()) throw Error('s15-metadata-1 replay offers Save comparison')
    await page.getByRole('button',{name:/schema four comparison/}).click()
    await page.getByRole('table').waitFor()
    await page.getByRole('button',{name:'Save comparison'}).waitFor()
    await page.getByRole('button',{name:'Save import'}).waitFor()
    await page.getByRole('button',{name:'Delete independent evidence'}).waitFor()
    await page.getByText(/Compared SEOsmith report: example\.com/).waitFor()
    const select=page.getByLabel('SEOsmith run'), box=page.getByRole('checkbox')
    if(!await box.isChecked()) throw Error('saved assertion not restored')
    await select.selectOption(b)
    if(await box.isChecked()) throw Error('assertion persisted across run switch')
    await box.check()
    // The default semantics is s15-metadata-2: the schema-4 report gives an absent observation that agrees with the CSV.
    await page.getByText(/1 agreement/).first().waitFor()
    delaySource = true
    const failed = page.waitForResponse(response => response.url().endsWith('/independent_audit_history') && response.status() === 500)
    await page.getByRole('button',{name:/example.csv/}).click()
    releaseSource()
    await failed
    await page.getByRole('alert').getByText('stale source failure').waitFor()
    if(await page.getByText(/Compared SEOsmith report/).count()) throw Error('failed import selection retained prior report metadata')
    delaySource = false
    await page.getByRole('button',{name:/example.csv/}).click()
    await page.getByText(/Original file: example\.csv/).waitFor()
    if(await select.inputValue() !== '' || await box.isChecked() || await page.getByRole('table').count()) throw Error('import switch retained prior run')
    if(await page.getByText(/Compared SEOsmith report/).count()) throw Error('import switch retained prior report metadata')
    await page.getByRole('button',{name:/legacy.csv/}).click()
    await page.getByText('Legacy source note').waitFor()
    await page.getByText('Legacy free-text note: parser and rendering differences not assessed.').waitFor()
    if(await page.getByText(/Compared SEOsmith report/).count()) throw Error('legacy import switch retained prior report metadata')
    const { readFileSync } = await import('node:fs')
    const file = readFileSync(new URL('./independent-tool-controlled.csv', import.meta.url))
    await page.locator('main.page-shell input[type=file]').setInputFiles({ name: 'independent-tool-controlled.csv', mimeType: 'text/csv', buffer: file })
    await page.getByLabel('Independent tool').fill('locally generated standalone crawler')
    await page.getByLabel('Tool version').fill('9.4')
    const imported = page.waitForResponse(response => response.url().includes('/import_independent_audit') && response.status() === 200)
    await page.getByRole('button',{name:'Save import'}).click()
    await imported
    if (importBodies.length !== 1 || importBodies[0].p_format !== 'controlled-csv-v1' || importBodies[0].p_metadata?.provenance?.tool !== 'locally generated standalone crawler' || importBodies[0].p_metadata?.provenance?.version !== '9.4') throw Error(`import provenance not submitted: ${JSON.stringify(importBodies)}`)
    await page.getByRole('button',{name:/saved comparison/}).click()
    await page.getByRole('table').waitFor()
    await page.getByText(/1 agreement/).waitFor()
    // A freshly selected schema-1 report replays under s15-metadata-1 and cannot be saved.
    await select.selectOption(c)
    await page.getByText(/schema version 1/).waitFor()
    await page.getByRole('table').waitFor()
    if (await page.getByRole('button',{name:'Save comparison'}).count()) throw Error('fresh schema-1 report offers Save comparison')
  }
}
if(errors.length) throw Error(JSON.stringify(errors))
console.log(`${mode}: dashboard entry and direct page fixture passed; RPCs: ${calls.join(', ')}`)
await browser.close()
