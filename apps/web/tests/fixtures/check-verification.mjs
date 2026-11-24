import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
const server = await createServer({ configFile: 'tests/fixtures/vite.config.mjs' })
let browser
try {
 await server.listen(); browser = await chromium.launch({ headless: true })
 for (const eligible of ['yes','no']) {
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:4177/tests/fixtures/verification.html?eligible=${eligible}`)
  if (eligible === 'no') { await page.waitForTimeout(100); assert.equal(await page.getByRole('button',{name:'Verify domain'}).count(),0); assert.deepEqual(await page.evaluate(()=>window.verificationFixture.calls),[]); await page.close(); continue }
  await page.getByRole('button',{name:'Verify domain'}).click()
  await page.getByRole('button',{name:'Create DNS challenge'}).click()
  await page.getByRole('button',{name:'Close domain verification'}).click(); await page.getByRole('button',{name:'Verify domain'}).click()
  assert.equal(await page.getByText('htp-verification='+'a'.repeat(64)).count(),1)
  assert.equal(await page.getByRole('button',{name:'Create DNS challenge'}).count(),0)
  await page.evaluate(()=>window.verificationFixture.fail(true)); await page.getByRole('button',{name:'Verify DNS record'}).click(); await page.getByRole('alert').waitFor()
  assert.equal(await page.getByText('htp-verification='+'a'.repeat(64)).count(),1)
  await page.evaluate(()=>window.verificationFixture.fail(false)); await page.getByRole('button',{name:'Verify DNS record'}).click(); await page.getByText('Domain verified.').waitFor()
  const calls = await page.evaluate(()=>window.verificationFixture.calls)
  assert.deepEqual(calls.map(x=>x[0]),['begin_form_host_verification','form-verify','form-verify']); assert.deepEqual(calls[0][1],{p_website_id:'fixture-site',p_hostname:'www.example.test'})
  await page.close()
 }
 const uncertain = await browser.newPage(); await uncertain.goto('http://127.0.0.1:4177/tests/fixtures/verification.html?eligible=yes'); await uncertain.getByRole('button',{name:'Verify domain'}).click(); await uncertain.evaluate(()=>window.verificationFixture.fail(true)); await uncertain.getByRole('button',{name:'Create DNS challenge'}).click(); await uncertain.getByRole('alert').waitFor(); assert.equal(await uncertain.getByRole('button',{name:'Create DNS challenge'}).count(),0); assert.equal((await uncertain.evaluate(()=>window.verificationFixture.calls)).length,1); await uncertain.reload(); await uncertain.getByRole('button',{name:'Verify domain'}).click(); assert.equal(await uncertain.getByRole('button',{name:'Create DNS challenge'}).count(),0); await uncertain.close()
 const expired = await browser.newPage(); await expired.clock.install(); await expired.goto('http://127.0.0.1:4177/tests/fixtures/verification.html?eligible=yes'); await expired.getByRole('button',{name:'Verify domain'}).click(); await expired.getByRole('button',{name:'Create DNS challenge'}).click(); await expired.clock.fastForward('24:00:01'); await expired.getByRole('button',{name:'Verify DNS record'}).click(); await expired.getByText('This challenge may have expired. Contact support before requesting a replacement.').waitFor(); assert.deepEqual((await expired.evaluate(()=>window.verificationFixture.calls)).map(x=>x[0]),['begin_form_host_verification']); await expired.close()
 const pendingEligibility = await browser.newPage(); await pendingEligibility.goto('http://127.0.0.1:4177/tests/fixtures/verification.html?eligible=yes&hold=eligibility'); await pendingEligibility.waitForFunction(()=>window.verificationFixture.waiting()); await pendingEligibility.evaluate(()=>window.verificationFixture.signOut()); await pendingEligibility.evaluate(()=>window.verificationFixture.release()); await pendingEligibility.waitForTimeout(100); assert.equal(await pendingEligibility.getByRole('button',{name:'Verify domain'}).count(),0); await pendingEligibility.close()
 for (const operation of ['begin_form_host_verification','form-verify']) {
  const stale = await browser.newPage(); await stale.goto('http://127.0.0.1:4177/tests/fixtures/verification.html?eligible=yes'); await stale.getByRole('button',{name:'Verify domain'}).click()
  if (operation === 'form-verify') await stale.getByRole('button',{name:'Create DNS challenge'}).click()
  await stale.evaluate(op=>window.verificationFixture.hold(op),operation)
  await stale.getByRole('button',{name:operation==='form-verify'?'Verify DNS record':'Create DNS challenge'}).click()
  await stale.waitForFunction(()=>window.verificationFixture.waiting())
  await stale.evaluate(()=>window.verificationFixture.signOut()); await stale.evaluate(()=>window.verificationFixture.release()); await stale.waitForTimeout(100)
  assert.equal(await stale.getByRole('button',{name:'Verify domain'}).count(),0)
  await stale.evaluate(()=>window.verificationFixture.signIn('fixture-owner')); await stale.getByRole('button',{name:'Verify domain'}).click()
  assert.equal(await stale.getByText('htp-verification='+'a'.repeat(64)).count(),0); assert.equal(await stale.getByText('Domain verified.').count(),0)
  assert.equal(await stale.getByRole('button',{name:'Create DNS challenge'}).count(),0)
  await stale.close()
 }
 console.log('PASS verification controls, denial, preservation, error, expiry and in-flight session changes')
} finally { await browser?.close(); await server.close() }
