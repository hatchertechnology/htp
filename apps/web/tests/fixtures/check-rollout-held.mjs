// Mocked authentication and data; run against a local preview only.
import { chromium } from 'playwright'
const origin = process.env.HTP_TEST_ORIGIN || 'http://127.0.0.1:3105'
const target = new URL(origin)
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('This test only runs against loopback HTTP.')
let rpcCalls = 0
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
   if (path.includes('/rest/v1/rpc/')) rpcCalls++
   const body=route.request().postDataJSON()||{}
   if(path.endsWith('/independent_audit_history')) return json(body.p_id?source:{items:[source],next_cursor:null})
   if(path.endsWith('/independent_comparison_history')) return json({items:[snapshot,unsupported],next_cursor:null})
   if(path.endsWith('/independent_comparison_detail')) return json({comparison:body.p_comparison_id === unsupported.id ? unsupported : snapshot,source,seosmith:{report,report_json:'original report',sha256:'abc'}})
   if(path.endsWith('/independent_evidence_fingerprint')) return json('fingerprint')
   return json(null)
 }
 // Static builds call the Fly API origin directly (no /api prefix); SSR previews use same-origin proxies.
 if(u.hostname==='htp-api-kerry-hatcher.fly.dev'){
   if(path==='/websites') return json({items:[{id,fqdn:'example.com'}],has_more:false})
   if(path===`/websites/${id}/seo/audits`) return json({items:[{delivery_id:a,scan_at:'run one',summary:{outcome:'completed'}},{delivery_id:b,scan_at:'run two',summary:{outcome:'completed'}}],next_cursor:null})
   if(path.startsWith(`/websites/${id}/seo/audits/`)) return json({report})
   if(path.startsWith('/providers/google/')||path.startsWith('/providers/bing/')) return json({connected:false,configured:false})
   return json(null)
 }
 if(path==='/api/websites') return json({items:[{id,fqdn:'example.com'}],has_more:false})
 if(path===`/api/websites/${id}/seo/audits`) return json({items:[{delivery_id:a,scan_at:'run one',summary:{outcome:'completed'}},{delivery_id:b,scan_at:'run two',summary:{outcome:'completed'}}],next_cursor:null})
 if(path.startsWith(`/api/websites/${id}/seo/audits/`)) return json({report})
 if(path.startsWith('/api/google/')||path.startsWith('/api/bing/')) return json({connected:false,configured:false})
 return route.continue()
})
if (process.env.HTP_ENABLED === '1') {
  await page.goto(`${origin}/websites`)
  await page.getByTestId('website-settings-fqdn').getByText('example.com').waitFor()
  await page.goto(`${origin}/forms`)
  await page.getByRole('heading',{name:'Forms',exact:true}).waitFor()
  await page.getByRole('tab',{name:'Responses'}).waitFor()
  if (await page.getByText('Forms are not available in this workspace yet.').count()) throw Error('enabled forms page showed the held message')
  await page.goto(`${origin}/forms/confirm`)
  await page.getByRole('button',{name:'Confirm notifications'}).waitFor()
  if(errors.length) throw Error(JSON.stringify(errors))
  console.log('enabled app: forms page and confirmation controls available')
  await browser.close()
  process.exit(0)
}
await page.goto(`${origin}/independent-audits`)
await page.getByText('Independent audit comparisons are not available yet.').waitFor()
await page.waitForTimeout(1000)
if (rpcCalls) throw Error(`held comparison issued ${rpcCalls} RPCs`)
if (await page.getByRole('button',{name:'Export all independent evidence'}).count()) throw Error('held comparison controls visible')
await page.goto(`${origin}/websites`)
await page.getByTestId('website-settings-fqdn').getByText('example.com').waitFor()
await page.goto(`${origin}/forms`)
await page.getByText('Forms are not available in this workspace yet.').waitFor()
if (await page.getByRole('link',{name:'Forms',exact:true}).count()) throw Error('held Forms nav link visible')
await page.goto(`${origin}/forms/confirm`)
await page.getByText('Form notifications are not available yet.').waitFor()
if (await page.getByRole('button',{name:'Confirm notifications'}).count()) throw Error('held confirmation visible')
if(errors.length) throw Error(JSON.stringify(errors))
console.log('held app: comparison makes no RPC, forms and confirmation controls hidden')
await browser.close()
