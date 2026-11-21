import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(new URL('/tests/fixtures/forms.html', process.env.BING_FIXTURE_BASE_URL ?? 'http://127.0.0.1:4177').href)
    await page.getByRole('button', { name: /forms/i }).first().click()
    await page.getByRole('button', { name: 'Responses', exact: true }).click()
    await page.getByText('<script>unsafe</script>', { exact: true }).waitFor()
    assert.equal(await page.locator('#app script').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Export all CSV' }).isEnabled(), true)
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log('PASS: forms inbox safely renders response at desktop and mobile sizes')
} finally { await browser.close() }
