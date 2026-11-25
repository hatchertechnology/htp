import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.BING_FIXTURE_BASE_URL ?? 'http://127.0.0.1:4177'
const url = query => new URL('/tests/fixtures/forms-page.html' + query, base).href
const browser = await chromium.launch({ headless: true })

async function open(query, viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url(query))
  await page.waitForFunction(() => Boolean(globalThis.formsPageFixture))
  return { page, errors }
}

try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    // Flags off: an accurate message and no Forms requests at all.
    {
      const { page, errors } = await open('?flags=off', viewport)
      await page.getByText('Forms are not available in this workspace yet.').waitFor()
      const state = await page.evaluate(() => ({ api: globalThis.formsPageFixture.apiCalls(), calls: globalThis.formsPageFixture.calls(), queries: globalThis.formsPageFixture.queries() }))
      assert.deepEqual(state, { api: [], calls: [], queries: [] })
      assert.equal(await page.getByRole('tab', { name: 'Responses' }).count(), 0)
      assert.deepEqual(errors, [])
      await page.close()
    }

    // Pilot denied, foreign/other site and eligibility failure all fail closed
    // with the same accurate message and no inbox reads.
    for (const scenario of ['no', 'foreign', 'error']) {
      const { page, errors } = await open(`?flags=pilot&eligible=${scenario}`, viewport)
      await page.getByText("Forms aren't enabled for www.example.com. The Forms pilot is limited to approved websites.").waitFor()
      const state = await page.evaluate(() => ({ api: globalThis.formsPageFixture.apiCalls(), calls: globalThis.formsPageFixture.calls(), queries: globalThis.formsPageFixture.queries() }))
      assert.deepEqual(state, { api: [], calls: [], queries: [] }, `${scenario}: no forms reads`)
      assert.equal(await page.getByRole('tab', { name: 'Responses' }).count(), 0)
      assert.deepEqual(errors, [])
      await page.close()
    }
  }

  // Pilot eligible: the Responses table is the default view.
  {
    const { page, errors } = await open('?flags=pilot&eligible=yes')
    await page.getByRole('tab', { name: 'Responses' }).waitFor()
    assert.equal(await page.getByRole('tab', { name: 'Responses' }).getAttribute('aria-selected'), 'true')
    await page.getByRole('cell',{name:'<script>unsafe</script>',exact:true}).waitFor()
    assert.equal(await page.locator('#app script').count(), 0)
    const api = await page.evaluate(() => globalThis.formsPageFixture.apiCalls())
    assert.ok(api.some(call => call.includes('/forms/hosts?')))
    assert.ok(api.some(call => call.includes('/forms?limit=100&offset=0')))
    assert.ok(api.some(call => call.includes('/responses?limit=100&offset=0')))
    assert.deepEqual(errors, [])
    await page.close()
  }

  // Legacy mode: the same page and table without a pilot eligibility read.
  {
    const { page, errors } = await open('?flags=legacy')
    await page.getByRole('tab', { name: 'Responses' }).waitFor()
    await page.getByRole('cell',{name:'<script>unsafe</script>',exact:true}).waitFor()
    const state = await page.evaluate(() => ({ api: globalThis.formsPageFixture.apiCalls(), queries: globalThis.formsPageFixture.queries() }))
    assert.deepEqual(state.api, [])
    assert.ok(state.queries.includes('website_forms'))
    assert.ok(state.queries.includes('website_form_responses'))
    assert.deepEqual(errors, [])
    await page.close()
  }

  // No site: the page points at Website settings and makes no Forms requests.
  {
    const { page, errors } = await open('?flags=pilot&site=none')
    await page.getByText('Add a website first to use Forms.', { exact: false }).waitFor()
    assert.equal(await page.getByRole('link', { name: 'Go to Website settings' }).getAttribute('href'), '/websites')
    const state = await page.evaluate(() => ({ api: globalThis.formsPageFixture.apiCalls(), calls: globalThis.formsPageFixture.calls(), queries: globalThis.formsPageFixture.queries() }))
    assert.deepEqual(state, { api: [], calls: [], queries: [] })
    assert.deepEqual(errors, [])
    await page.close()
  }

  console.log('PASS: Forms page gating, availability messages, pilot/legacy tables and no-site state')
} finally {
  await browser.close()
}
