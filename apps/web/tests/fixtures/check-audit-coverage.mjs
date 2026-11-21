import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  await page.goto('http://127.0.0.1:4177/tests/fixtures/audit-coverage.html')
  await page.getByText('Per-rule coverage and evidence provenance are unavailable', { exact: false }).waitFor()
  assert.equal(await page.getByRole('table').count(), 0)
  await page.evaluate(() => globalThis.setCoverageFixture(true))
  await page.getByRole('table', { name: 'Rule coverage in the saved report' }).waitFor()
  assert.match(await page.locator('tr').nth(1).innerText(), /missing title\s+5\s+3\s+1\s+1\s+2\s+1\s+0\s+1\s+1\s+0\s+1\s+blocked: 1/)
  assert.match(await page.getByRole('status').innerText(), /2 observations were omitted/)
  assert.match(await page.locator('body').innerText(), /fixture-digest/)
  assert.deepEqual(errors, [])
  console.log('PASS: legacy unavailable and versioned truncated coverage render without inventing results')
} finally { await browser.close() }
