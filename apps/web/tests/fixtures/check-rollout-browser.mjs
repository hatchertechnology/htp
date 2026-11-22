import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const base = process.env.SEARCH_FIXTURE_BASE_URL || 'http://127.0.0.1:4184'
if (new URL(base).hostname !== '127.0.0.1') throw new Error('Loopback only')
const browser = await chromium.launch({headless:true})
try {
  const page = await browser.newPage(), errors=[]
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/tests/fixtures/search-dashboard-evaluation.html?held=1`)
  await page.locator('#inspect-url').waitFor()
  assert.equal(await page.locator('#crawl-delivery').count(), 0)
  assert.equal(await page.getByTestId('search-evidence-mounted').count(), 0)
  assert.equal(await page.locator('#inspect-url').count(), 1)
  await page.goto(`${base}/tests/fixtures/search-dashboard-evaluation.html`)
  await page.locator('#crawl-delivery').waitFor()
  await page.getByTestId('search-evidence-mounted').waitFor({state:'attached'})
  await page.goto(`${base}/tests/fixtures/seosmith-lifecycle.html?single=1&held=1`)
  await page.getByText('URLs checked in this run', {exact:false}).click()
  assert.equal(await page.getByRole('button', {name:'Read URL history'}).count(), 0)
  assert.equal(await page.getByRole('button', {name:'Read finding history'}).count(), 0)
  await page.goto(`${base}/tests/fixtures/seosmith-lifecycle.html?single=1`)
  await page.getByRole('button', {name:'Read finding history'}).waitFor()
  assert.deepEqual(errors, [])
  console.log('held/enabled search and lifecycle controls preserve legacy inspection and reports')
} finally { await browser.close() }
