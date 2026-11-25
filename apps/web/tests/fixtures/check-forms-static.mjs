// Static pilot mode: eligible inbox reads go through the owner API, not browser table queries.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(new URL('/tests/fixtures/forms.html?mode=pilot&static=1', process.env.BING_FIXTURE_BASE_URL ?? 'http://127.0.0.1:4177').href)
  await page.getByRole('tab', { name: 'Responses', exact: true }).waitFor()
  await page.getByRole('cell',{name:'<script>unsafe</script>',exact:true}).waitFor()
  assert.equal(await page.locator('#app script').count(), 0)
  const fixture = await page.evaluate(() => ({ queries: globalThis.formFixture.queries, apiCalls: globalThis.formFixture.apiCalls }))
  assert.ok(fixture.apiCalls.some(url => /\/websites\/10000000-0000-0000-0000-000000000001\/forms\/10000000-0000-0000-0000-000000000002\/responses\?limit=100&offset=0$/.test(url)), 'responses must be read via the API')
  assert.ok(fixture.apiCalls.some(url => /\/websites\/10000000-0000-0000-0000-000000000001\/forms\?limit=/.test(url)), 'forms must be read via the API')
  assert.ok(!fixture.queries.includes('website_form_responses'), 'no browser response table read in static pilot mode')
  assert.ok(!fixture.queries.includes('website_forms'), 'no browser forms table read in static pilot mode')
  assert.deepEqual(errors, [])
  console.log('PASS: static pilot reads use the owner API for forms and responses')
} finally { await browser.close() }
