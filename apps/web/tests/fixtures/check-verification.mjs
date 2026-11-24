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
 console.log('PASS verification controls, denial, preservation, error and expiry')
} finally { await browser?.close(); await server.close() }
