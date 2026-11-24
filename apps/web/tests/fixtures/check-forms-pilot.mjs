import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser=await chromium.launch({headless:true})
const base=process.env.BING_FIXTURE_BASE_URL ?? 'http://127.0.0.1:4177'
const url=query=>new URL('/tests/fixtures/forms.html'+query,base).href
try {
 for(const viewport of [{width:1280,height:800},{width:390,height:844}]) {
  for(const scenario of ['no','other-site','foreign','error']) {
   const page=await browser.newPage({viewport});await page.goto(url(`?mode=pilot&eligible=${scenario}`));await page.waitForFunction(()=>Boolean(globalThis.formFixture))
   assert.equal(await page.getByRole('button',{name:'Forms',exact:true}).count(),0,`${scenario} must stay hidden`)
   assert.deepEqual(await page.evaluate(()=>globalThis.formFixture.queries),[]);await page.close()
  }
  const page=await browser.newPage({viewport}), errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto(url('?mode=pilot&eligible=yes'));await page.getByRole('button',{name:'Forms',exact:true}).click()
  await page.getByRole('button',{name:'Create DNS challenge'}).click();await page.getByRole('button',{name:'Verify DNS record'}).click()
  await page.getByLabel('Form name').fill('New form');await page.getByLabel('Form key').fill('new_form');await page.getByRole('button',{name:'Save form'}).click()
  await page.getByRole('button',{name:'Responses',exact:true}).click();await page.getByText('<script>unsafe</script>',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Export all CSV'}).isEnabled(),true)
  for(const name of ['Mark reviewed','Mark spam','Delete','Send verification','Disable','Retry']) assert.equal(await page.getByRole('button',{name,exact:true}).count(),0,`${name} is held`)
  assert.equal(await page.getByRole('heading',{name:'Notification recipients'}).count(),0)
  const state=await page.evaluate(()=>({calls:globalThis.formFixture.calls,queries:globalThis.formFixture.queries}))
  assert.deepEqual(state.calls,['begin_form_host_verification','form-verify','save_website_form'])
  assert.ok(!state.queries.includes('website_form_recipients')&&!state.queries.includes('website_form_delivery_jobs'))
  assert.deepEqual(errors,[]);await page.close()
 }
 const legacy=await browser.newPage();await legacy.goto(url(''));await legacy.getByRole('button',{name:'Forms',exact:true}).click();await legacy.getByRole('button',{name:'Responses',exact:true}).click();await legacy.getByRole('heading',{name:'Notification recipients'}).waitFor();for(const name of ['Mark reviewed','Mark spam','Delete','Send verification','Disable','Retry']) assert.equal(await legacy.getByRole('button',{name,exact:true}).count(),1,`legacy ${name}`);await legacy.close()
 for(const operation of ['setOwner','setAnonymous']) {const stale=await browser.newPage();await stale.goto(url('?mode=pilot&eligible=slow'));await stale.waitForFunction(()=>Boolean(globalThis.formFixture));await stale.evaluate(operation=>{if(operation==='setOwner')globalThis.formFixture.setOwner(null);else globalThis.formFixture.setAnonymous()},operation);await stale.waitForTimeout(700);assert.equal(await stale.getByRole('button',{name:'Forms',exact:true}).count(),0);await stale.close()}
 console.log('PASS: pilot-only, denied, stale-session and legacy Forms controls')
} finally {await browser.close()}
