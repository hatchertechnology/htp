import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser = await chromium.launch({headless:true})
const base = process.env.BING_FIXTURE_BASE_URL ?? 'http://127.0.0.1:4177'
async function open(enabled) {
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(new URL(`/tests/fixtures/forms.html?mode=pilot&static=1${enabled?'&responses=1':''}`, base).href)
  await page.getByRole('tab',{name:'Responses'}).waitFor()
  return { page, errors }
}
try {
  // Default off: responses and export are readable, management controls are not.
  {
    const { page, errors } = await open(false)
    assert.equal(await page.getByRole('button',{name:'Mark reviewed',exact:true}).count(),0)
    assert.equal(await page.getByRole('button',{name:'Export all responses (CSV)'}).isEnabled(),true)
    assert.deepEqual(errors,[])
    await page.close()
  }

  // Enabled: bulk status is sequential and delete is explicit.
  {
    const { page, errors } = await open(true)
    const box = page.getByRole('checkbox',{name:/^Select response received/}).first()
    await box.check()
    await page.getByRole('group',{name:'Bulk response actions'}).getByRole('button',{name:'Mark reviewed'}).click()
    await page.waitForFunction(()=>globalThis.formFixture.state().bodies.filter(entry=>entry.method==='PATCH').length===1)
    await page.getByText('reviewed',{exact:true}).waitFor()
    await page.locator('details.row-actions summary').first().click()
    await page.getByRole('button',{name:'Delete',exact:true}).click()
    let state=await page.evaluate(()=>globalThis.formFixture.state())
    assert.equal(state.apiCalls.filter(x=>x.startsWith('DELETE ')).length,0)
    await page.getByRole('button',{name:'Delete response',exact:true}).click()
    await page.getByText('No responses to display.').waitFor()
    state=await page.evaluate(()=>globalThis.formFixture.state())
    assert.equal(state.apiCalls.filter(x=>x.startsWith('DELETE ')).length,1)
    assert.deepEqual(state.bodies.filter(x=>x.method==='PATCH').map(x=>x.body),[{status:'reviewed'}])
    assert.deepEqual(state.calls,[]); assert.deepEqual(state.queries,[])
    assert.deepEqual(errors,[])
    await page.close()
  }

  // An applied-but-lost status write is an unknown outcome: the table locks and no retry is sent.
  {
    const { page, errors } = await open(true)
    await page.getByRole('checkbox',{name:/^Select response received/}).first().check()
    await page.evaluate(()=>globalThis.formFixture.failNext('response',undefined,true))
    await page.getByRole('group',{name:'Bulk response actions'}).getByRole('button',{name:'Mark spam'}).click()
    await page.getByRole('alert').filter({hasText:'outcome is unknown'}).waitFor()
    const state=await page.evaluate(()=>globalThis.formFixture.state())
    assert.equal(state.apiCalls.filter(x=>x.startsWith('PATCH ')).length,1,'no retry after an unknown outcome')
    assert.equal(await page.getByRole('checkbox',{name:/^Select response received/}).first().isDisabled(),true)
    assert.deepEqual(state.calls,[]); assert.deepEqual(state.queries,[])
    assert.deepEqual(errors,[])
    await page.close()
  }
  console.log('Static response fixture passed: default off, sequential bulk status, unknown lock/no retry, explicit delete, no RPC')
} finally {await browser.close()}
