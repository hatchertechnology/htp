import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const browser=await chromium.launch({headless:true})
const base=process.env.BING_FIXTURE_BASE_URL ?? 'http://127.0.0.1:4177'
const url=query=>new URL('/tests/fixtures/forms.html'+query,base).href
try {
 for(const enabled of [false,true]) {
  const page=await browser.newPage({viewport:{width:390,height:844}})
  await page.goto(url(`?mode=pilot&static=1${enabled?'&notifications=1':''}`))
  await page.getByRole('tab',{name:'Responses'}).waitFor()
  await page.getByRole('tab',{name:'Setup'}).click()
  assert.equal(await page.getByRole('button',{name:'Request verification',exact:true}).count(),enabled?1:0)
  if(enabled) {
   await page.getByText('<unsafe>@example.test',{exact:false}).waitFor()
   assert.equal(await page.getByText('SECRET',{exact:false}).count(),0)
   await page.getByRole('button',{name:'More recipients',exact:true}).click()
   await page.getByRole('button',{name:'More delivery jobs',exact:true}).click()
   const pagination=await page.evaluate(()=>globalThis.formFixture.state().apiCalls)
   assert.ok(pagination.some(x=>x.includes('recipients?limit=100&offset=1')))
   assert.ok(pagination.some(x=>x.includes('delivery-jobs?limit=100&offset=1')))
   assert.equal(await page.getByRole('button',{name:'Disable recipient',exact:true}).count(),1)
   assert.equal(await page.getByRole('button',{name:'Retry delivery',exact:true}).count(),1)
   await page.getByRole('button',{name:'More recipients',exact:true}).click()
   await page.waitForFunction(()=>globalThis.formFixture.state().apiCalls.some(x=>x.includes('recipients?limit=100&offset=2')))
   await page.getByRole('region',{name:'Form notifications'}).getByRole('textbox').fill('fixture@example.test')
   await page.getByRole('button',{name:'Request verification',exact:true}).click()
   await page.getByText(/Queue request accepted/).waitFor()
   await page.getByRole('region',{name:'Form notifications'}).getByRole('textbox').fill('fixture@example.test')
   // A known refusal remains visible after the automatic metadata readback.
   await page.evaluate(()=>globalThis.formFixture.failNext('notification','notification_not_retryable'))
   page.once('dialog',d=>d.accept())
   await page.getByRole('button',{name:'Retry delivery',exact:true}).click()
   await page.getByRole('alert').filter({hasText:'Request refused or not sent'}).waitFor()
   await page.waitForFunction(()=>!document.querySelector('button[type=submit][disabled]'))
   assert.equal(await page.getByRole('alert').filter({hasText:'Request refused or not sent'}).count(),1)
   // A refused write remains known even when its automatic readback fails.
   await page.evaluate(()=>{
    globalThis.formFixture.failNext('notification','invalid_request')
    globalThis.formFixture.failNext('notification-read-recipients')
   })
   await page.getByRole('button',{name:'Request verification',exact:true}).click()
   await page.getByRole('alert').filter({hasText:'Could not read notification metadata'}).waitFor()
   assert.equal(await page.getByRole('alert').filter({hasText:'Request refused or not sent'}).count(),1)
   assert.equal(await page.getByRole('alert').filter({hasText:'Outcome unknown'}).count(),0)
   assert.equal(await page.getByRole('button',{name:'Request verification',exact:true}).isDisabled(),false)
   await page.evaluate(()=>globalThis.formFixture.failNext('notification'))
   await page.getByRole('button',{name:'Disable recipient',exact:true}).click()
   await page.getByRole('alert').filter({hasText:'Outcome unknown'}).waitFor()
   assert.equal(await page.getByRole('button',{name:'Request verification',exact:true}).isDisabled(),true)
   // A partial full-read failure must retain the unknown-outcome write lock.
   await page.evaluate(()=>globalThis.formFixture.failNext('notification-read-delivery-jobs'))
   await page.getByRole('button',{name:'Reload notification metadata'}).click()
   await page.getByRole('alert').filter({hasText:'Could not read notification metadata'}).waitFor()
   assert.equal(await page.getByRole('button',{name:'Request verification',exact:true}).isDisabled(),true)
   await page.getByRole('button',{name:'More recipients',exact:true}).click()
   await page.getByRole('button',{name:'Reload notification metadata'}).waitFor({state:'visible'})
   await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Reload notification metadata').disabled)
   assert.equal(await page.getByRole('button',{name:'Request verification',exact:true}).isDisabled(),true)
   await page.getByRole('button',{name:'Reload notification metadata'}).click()
   await page.waitForFunction(()=>!document.querySelector('button[type=submit][disabled]'))
   page.once('dialog',d=>d.accept())
   await page.getByRole('button',{name:'Retry delivery',exact:true}).click()
   await page.getByText(/Queue request accepted/).waitFor()
   const state=await page.evaluate(()=>globalThis.formFixture.state())
   assert.equal(state.apiCalls.filter(x=>x.startsWith('POST ')&&/recipients|delivery-jobs/.test(x)).length,5)
   assert.deepEqual(state.calls,[]); assert.deepEqual(state.queries,[])
   await page.screenshot({path:join(tmpdir(),'forms-notifications-mobile.png'),fullPage:true})
   await page.setViewportSize({width:1280,height:900})
   await page.screenshot({path:join(tmpdir(),'forms-notifications-desktop.png'),fullPage:true})
   const before=state.apiCalls.filter(x=>/recipients|delivery-jobs/.test(x)).length
   await page.evaluate(()=>globalThis.formFixture.setOwner(null))
   await page.getByRole('region',{name:'Form notifications'}).waitFor({state:'detached'})
   assert.equal((await page.evaluate(()=>globalThis.formFixture.state().apiCalls)).filter(x=>/recipients|delivery-jobs/.test(x)).length,before)
  }
  if (!enabled) assert.equal((await page.evaluate(()=>globalThis.formFixture.state().apiCalls)).filter(x=>/recipients|delivery-jobs/.test(x)).length,0)
  await page.close()
 }
 for (const capability of ['secondary','off','old']) {
  const page=await browser.newPage()
  await page.goto(url(`?mode=pilot&static=1&notifications=1&capability=${capability}`))
  await page.getByRole('tab',{name:'Responses'}).waitFor()
  await page.getByRole('tab',{name:'Setup'}).click()
  assert.equal(await page.getByRole('region',{name:'Form notifications'}).count(),0)
  const calls=await page.evaluate(()=>globalThis.formFixture.state().apiCalls)
  assert.equal(calls.filter(x=>/recipients|delivery-jobs/.test(x)).length,0)
  await page.close()
 }
 for (const change of ['owner','site']) {
  const page=await browser.newPage()
  await page.goto(url('?mode=pilot&static=1&notifications=1&eligible=slow'))
  await page.waitForFunction(()=>globalThis.formFixture?.state().apiCalls.length===1)
  await page.evaluate(change=>change==='owner'?globalThis.formFixture.setOwner(null):globalThis.formFixture.setSite('10000000-0000-0000-0000-000000000099'),change)
  await page.waitForTimeout(700)
  assert.equal(await page.getByRole('region',{name:'Form notifications'}).count(),0)
  assert.equal(await page.getByRole('tab',{name:'Responses'}).count(),0)
  assert.equal((await page.evaluate(()=>globalThis.formFixture.state().apiCalls)).filter(x=>/recipients|delivery-jobs/.test(x)).length,0)
  await page.close()
 }
 console.log('Static notification browser fixture passed')
} finally {await browser.close()}
