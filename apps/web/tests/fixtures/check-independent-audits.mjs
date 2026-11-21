// Mocked authentication and data; run against a local preview only.
import { chromium } from 'playwright'
const origin = process.env.HTP_TEST_ORIGIN || 'http://127.0.0.1:3105'
const target = new URL(origin)
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('This test only runs against loopback HTTP.')
const browser=await chromium.launch({headless:true}), page=await browser.newPage(), errors=[]
page.on('pageerror',e=>errors.push(e.message))
const id='00000000-0000-0000-0000-000000000003', a='00000000-0000-0000-0000-000000000004', b='00000000-0000-0000-0000-000000000005', src='00000000-0000-0000-0000-000000000006', exp=Math.floor(Date.now()/1000)+3600
const token=`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',exp})).toString('base64url')}.fake`
await page.addInitScript(({token,exp})=>localStorage.setItem('sb-raxuvdbdfmmtpqjcafcq-auth-token',JSON.stringify({access_token:token,refresh_token:'fake',token_type:'bearer',expires_in:3600,expires_at:exp,user:{id:'00000000-0000-0000-0000-000000000001',aud:'authenticated',role:'authenticated'}})),{token,exp})
const report={schema_version:1,engine_version:'0.2.0',ruleset_version:'2026-11-01.1',outcome:'completed',stop_reason:'frontier_exhausted',coverage_complete:true,pages:[{url:'https://example.com/',status:200,content_type:'text/html',error:null,is_resource:false,blocked_by_robots:false,flags:[],extraction_truncated:false}],findings:[]}
const snapshot={id:'00000000-0000-0000-0000-000000000007',fqdn:'old.example.com',created_at:'saved comparison',semantics:'s15-metadata-1',import_id:src,delivery_id:a,unmodified_v1_asserted:true}
const unsupported={...snapshot,id:'00000000-0000-0000-0000-000000000008',created_at:'future comparison',semantics:'future-semantics'}
const source={id:src,fqdn:'example.com',source_text:'url,rule,state\nhttps://example.com/,missing_title,absent\n',metadata:{filename:'example.csv'},source_sha256:'x'}
await page.route('**/*',async route=>{
 const u=new URL(route.request().url()), path=u.pathname, json=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)})
 if(u.hostname==='raxuvdbdfmmtpqjcafcq.supabase.co'){
   if(path.includes('/auth/v1/')) return json({id:'00000000-0000-0000-0000-000000000001',aud:'authenticated'})
   const body=route.request().postDataJSON()||{}
   if(path.endsWith('/independent_audit_history')) return json(body.p_id?source:{items:[source],next_cursor:null})
   if(path.endsWith('/independent_comparison_history')) return json({items:[snapshot,unsupported],next_cursor:null})
   if(path.endsWith('/independent_comparison_detail')) return json({comparison:body.p_comparison_id === unsupported.id ? unsupported : snapshot,source,seosmith:{report,report_json:'original report',sha256:'abc'}})
   if(path.endsWith('/independent_evidence_fingerprint')) return json('fingerprint')
   return json(null)
 }
 if(path==='/api/websites') return json({items:[{id,fqdn:'example.com'}],has_more:false})
 if(path===`/api/websites/${id}/seo/audits`) return json({items:[{delivery_id:a,scan_at:'run one',summary:{outcome:'completed'}},{delivery_id:b,scan_at:'run two',summary:{outcome:'completed'}}],next_cursor:null})
 if(path.startsWith(`/api/websites/${id}/seo/audits/`)) return json({report})
 if(path.startsWith('/api/google/')||path.startsWith('/api/bing/')) return json({connected:false,configured:false})
 return route.continue()
})
await page.goto(`${origin}/independent-audits`); await page.getByRole('button',{name:/example.csv/}).waitFor({timeout:20000}); await page.getByRole('button',{name:/saved comparison/}).click(); const select=page.getByLabel('SEOsmith run'); const box=page.getByRole('checkbox'); if(!await box.isChecked()) throw Error('saved assertion not restored'); await select.selectOption(b); if(await box.isChecked()) throw Error('assertion persisted across run switch'); await box.check(); await page.getByRole('button',{name:/example.csv/}).click(); if(await select.inputValue() !== '' || await box.isChecked() || await page.getByRole('table').count()) throw Error('import switch retained prior run'); const downloadPromise=page.waitForEvent('download'); await page.getByRole('button',{name:'Export all independent evidence'}).click(); const download=await downloadPromise; const {readFile}=await import('node:fs/promises'); const exported=JSON.parse(await readFile(await download.path(),'utf8')); if(exported.sources.length!==1 || exported.comparisons[0].seosmith.report_json!=='original report' || exported.comparisons[0].comparison.fqdn!=='old.example.com') throw Error('incomplete export'); await page.getByRole('button',{name:/future comparison/}).click(); await page.getByRole('alert').getByText(/unsupported semantics/).waitFor(); if(await page.getByRole('table').count()) throw Error('unsupported semantics replayed'); console.log('authenticated mock: replay, import/run reset, unsupported version and complete export passed; page errors:',JSON.stringify(errors)); await browser.close(); if(errors.length) process.exitCode=1
