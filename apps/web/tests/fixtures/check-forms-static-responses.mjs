import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser = await chromium.launch({headless:true})
try {
 for (const enabled of [false,true]) {
  const page = await browser.newPage()
  const errors=[]; page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://127.0.0.1:4177/tests/fixtures/forms.html?mode=pilot&static=1${enabled?'&responses=1':''}`)
  await page.getByRole('button',{name:'Forms',exact:true}).click()
  await page.getByRole('button',{name:'Responses',exact:true}).click()
  assert.equal(await page.getByRole('button',{name:'Mark reviewed',exact:true}).count(),enabled?1:0)
  if(enabled) {
   await page.getByRole('button',{name:'Mark reviewed',exact:true}).click()
   await page.waitForFunction(()=>globalThis.formFixture.state().apiCalls.some(x=>x.startsWith('PATCH ')))
   await page.getByText(/— reviewed/).waitFor()
   await page.evaluate(()=>globalThis.formFixture.failNext('response',undefined,true))
   await page.getByRole('button',{name:'Mark spam',exact:true}).click()
   await page.getByRole('alert').filter({hasText:'outcome is unknown'}).waitFor()
   assert.equal(await page.getByRole('button',{name:'Mark spam',exact:true}).isDisabled(),true)
   await page.getByRole('button',{name:'Responses',exact:true}).click()
   await page.getByRole('button',{name:'Delete',exact:true}).click()
   let state=await page.evaluate(()=>globalThis.formFixture.state())
   assert.equal(state.apiCalls.filter(x=>x.startsWith('DELETE ')).length,0)
   await page.getByRole('button',{name:'Delete response',exact:true}).click()
   await page.getByText('No responses to display.').waitFor()
   state=await page.evaluate(()=>globalThis.formFixture.state())
   assert.equal(state.apiCalls.filter(x=>x.startsWith('DELETE ')).length,1)
   assert.equal(state.apiCalls.filter(x=>x.startsWith('PATCH ')).length,2)
   assert.deepEqual(state.bodies.filter(x=>x.method==='PATCH').map(x=>x.body),[{status:'reviewed'},{status:'spam'}])
   assert.deepEqual(state.calls,[]); assert.deepEqual(state.queries,[])
  }
  assert.deepEqual(errors,[])
  await page.close()
 }
 console.log('Static response fixture passed: default off, status, unknown reload/no retry, explicit delete, no RPC')
} finally {await browser.close()}
