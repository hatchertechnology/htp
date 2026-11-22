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
    await page.evaluate(() => globalThis.setChallengeError('form_host_rate_limited'))
    await page.getByRole('button', { name: 'Create DNS challenge' }).click()
    await page.getByText('Too many verification requests. Try again in 10 minutes.').waitFor()
    await page.evaluate(() => globalThis.setChallengeError('form_host_limit'))
    await page.getByRole('button', { name: 'Create DNS challenge' }).click()
    await page.getByText('This website has reached its limit of 64 hosts.').waitFor()
    await page.evaluate(() => globalThis.setChallengeError('form_host_account_limit'))
    await page.getByRole('button', { name: 'Create DNS challenge' }).click()
    await page.getByText('This account has reached its limit of 256 hosts.').waitFor()
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log('PASS: forms inbox safely renders response at desktop and mobile sizes')
} finally { await browser.close() }
