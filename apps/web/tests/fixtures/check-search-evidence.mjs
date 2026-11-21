import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser = await chromium.launch({headless:true})
const page = await browser.newPage({viewport:{width:390,height:844}})
const errors=[]; page.on('pageerror', error=>errors.push(error.message))
try {
  await page.goto('http://127.0.0.1:4177/tests/fixtures/search-evidence.html')
  await page.getByText('cleaning', {exact:true}).waitFor()
  await page.getByLabel('Dataset').selectOption('query_page_segments')
  await page.locator('label').filter({hasText:'Device'}).last().locator('select').selectOption('MOBILE')
  await page.getByLabel('Country code').fill('usa')
  await page.getByText('cleaning · https://example.com/ · MOBILE · usa').waitFor()
  assert.match(await page.locator('body').innerText(), /collection reached its limit/)
  await page.getByLabel('Dataset').selectOption('analysis')
  await page.getByText(/No saved analysis evidence/).waitFor()
  assert.deepEqual(errors,[])
  console.log('PASS: search evidence renders filters, truncation and unavailable state at mobile width')
} finally { await browser.close() }
