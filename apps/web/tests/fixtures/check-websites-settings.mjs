import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.BING_FIXTURE_BASE_URL ?? 'http://127.0.0.1:4177'
if (new URL(base).hostname !== '127.0.0.1') throw new Error('Loopback only')
const ONE = '00000000-0000-0000-0000-000000000001'
const TWO = '00000000-0000-0000-0000-000000000002'
const browser = await chromium.launch({ headless: true })

try {
  for (const mode of [0, 1]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const fqdn = page.getByTestId('website-settings-fqdn')
    await page.goto(`${base}/tests/fixtures/websites-settings.html?static=${mode}`)
    await fqdn.waitFor()

    // (a) Settings for the selected site: no list of every website.
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1)
    assert.equal(await page.getByRole('heading', { name: 'Website settings' }).count(), 1)
    assert.equal(await fqdn.textContent(), 'one.example.com')
    assert.equal(await page.getByText('two.example.com').count(), 0)
    assert.equal(await page.locator('.website-rows').count(), 0)
    assert.equal(await page.locator('li').count(), 0)

    // (b) The header selection drives the Domain field, GA4 field and repository settings.
    await page.evaluate(id => globalThis.websitesFixture.select(id), TWO)
    await page.waitForFunction(() => document.querySelector('[data-testid="website-settings-fqdn"]')?.textContent?.trim() === 'two.example.com')
    assert.equal(await page.locator('#website-fqdn').inputValue(), 'two.example.com')
    assert.equal(await page.getByLabel('GA4 property ID').inputValue(), '')
    assert.equal(await page.getByTestId('repository-settings').getAttribute('data-website-id'), TWO)
    assert.equal(await page.getByTestId('repository-settings').getAttribute('data-fqdn'), 'two.example.com')

    // (c) Save domain sends a PATCH with the canonical FQDN.
    await page.locator('#website-fqdn').fill(' WWW.Example.COM. ')
    await page.getByRole('button', { name: 'Save domain' }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="website-settings-fqdn"]')?.textContent?.trim() === 'www.example.com')
    let calls = await page.evaluate(() => globalThis.websitesFixture.calls)
    const patches = calls.filter(call => call.method === 'PATCH')
    assert.equal(patches.length, 1)
    assert.ok(patches[0].url.endsWith(`/websites/${TWO}`))
    assert.deepEqual(patches[0].body, { fqdn: 'www.example.com' })
    assert.equal(patches[0].headers.Authorization, 'Bearer fixture-token')

    // (d) GA4 property: non-numeric input never reaches the API; a numeric ID is saved with PUT.
    const before = calls.length
    await page.getByLabel('GA4 property ID').fill('not-a-number')
    await page.getByRole('button', { name: 'Save property' }).click()
    await page.getByText('Enter a numeric GA4 property ID.').waitFor()
    calls = await page.evaluate(() => globalThis.websitesFixture.calls)
    assert.equal(calls.length, before)
    assert.equal(calls.filter(call => call.method === 'PUT').length, 0)
    await page.getByLabel('GA4 property ID').fill('557292489')
    await page.getByRole('button', { name: 'Save property' }).click()
    await page.waitForFunction(() => globalThis.websitesFixture.calls.some(call => call.method === 'PUT'))
    calls = await page.evaluate(() => globalThis.websitesFixture.calls)
    const puts = calls.filter(call => call.method === 'PUT')
    assert.equal(puts.length, 1)
    assert.ok(puts[0].url.includes(`/websites/${TWO}/analytics/property`))
    assert.deepEqual(puts[0].body, { property_id: '557292489' })

    // (e) Add a website: POST, then the created site becomes the selection.
    await page.getByTestId('new-website-fqdn').fill('new.example.com')
    await page.getByRole('button', { name: 'Add website' }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="website-settings-fqdn"]')?.textContent?.trim() === 'new.example.com')
    calls = await page.evaluate(() => globalThis.websitesFixture.calls)
    const posts = calls.filter(call => call.method === 'POST')
    assert.equal(posts.length, 1)
    assert.ok(posts[0].url.endsWith('/websites'))
    assert.deepEqual(posts[0].body, { fqdn: 'new.example.com' })

    // (f) Delete with the inline confirmation, then the selection falls back.
    await page.getByRole('button', { name: 'Delete this website' }).click()
    await page.getByRole('group', { name: 'Confirm deletion of new.example.com' }).waitFor()
    await page.getByRole('button', { name: 'Delete record' }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="website-settings-fqdn"]')?.textContent?.trim() === 'one.example.com')
    calls = await page.evaluate(() => globalThis.websitesFixture.calls)
    const deletes = calls.filter(call => call.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.ok(deletes[0].url.endsWith('/websites/00000000-0000-0000-0000-000000000009'))
    assert.equal(deletes[0].body, undefined)

    // (h) A selection switch mid-request must never write the old site's values
    // into the newly selected site's form (no stale-form-data race).
    // GA4: the held PUT belongs to one.example.com; two.example.com keeps its own
    // property value and no error appears.
    await page.evaluate(() => globalThis.websitesFixture.holdNext('PUT'))
    await page.getByLabel('GA4 property ID').fill('999999999')
    await page.getByRole('button', { name: 'Save property' }).click()
    await page.waitForFunction(() => globalThis.websitesFixture.calls.some(call => call.method === 'PUT' && call.body?.property_id === '999999999'))
    await page.evaluate(id => globalThis.websitesFixture.select(id), TWO)
    await page.waitForFunction(() => document.querySelector('[data-testid="website-settings-fqdn"]')?.textContent?.trim() === 'www.example.com')
    await page.evaluate(() => globalThis.websitesFixture.release())
    await page.waitForFunction(() => globalThis.websitesFixture.calls.filter(call => call.method === 'PUT').length === 2)
    await page.waitForTimeout(100)
    assert.equal(await page.getByLabel('GA4 property ID').inputValue(), '557292489')
    assert.equal(await page.locator('.form-error').count(), 0)

    // Add: the held POST belongs to the previous site; the switch wins and the
    // newly created record is not force-selected.
    await page.evaluate(() => globalThis.websitesFixture.holdNext('POST'))
    await page.getByTestId('new-website-fqdn').fill('late.example.com')
    await page.getByRole('button', { name: 'Add website' }).click()
    await page.waitForFunction(() => globalThis.websitesFixture.calls.some(call => call.method === 'POST' && call.body?.fqdn === 'late.example.com'))
    await page.evaluate(id => globalThis.websitesFixture.select(id), ONE)
    await page.waitForFunction(() => document.querySelector('[data-testid="website-settings-fqdn"]')?.textContent?.trim() === 'one.example.com')
    await page.evaluate(() => globalThis.websitesFixture.release())
    await page.waitForFunction(() => globalThis.websitesFixture.calls.filter(call => call.method === 'POST').length === 2)
    await page.waitForTimeout(100)
    assert.equal(await page.getByTestId('website-settings-fqdn').textContent(), 'one.example.com')
    assert.equal(await page.locator('.form-error').count(), 0)

    // Domain (MAJOR-1): the held PATCH belongs to one.example.com; after the
    // switch the field shows two.example.com, never the previous site's FQDN.
    await page.evaluate(() => globalThis.websitesFixture.holdNext('PATCH'))
    await page.locator('#website-fqdn').fill('changed.example.com')
    await page.getByRole('button', { name: 'Save domain' }).click()
    await page.waitForFunction(() => globalThis.websitesFixture.calls.some(call => call.method === 'PATCH' && call.body?.fqdn === 'changed.example.com'))
    await page.evaluate(id => globalThis.websitesFixture.select(id), TWO)
    await page.waitForFunction(() => document.querySelector('[data-testid="website-settings-fqdn"]')?.textContent?.trim() === 'www.example.com')
    assert.equal(await page.locator('#website-fqdn').inputValue(), 'www.example.com')
    await page.evaluate(() => globalThis.websitesFixture.release())
    await page.waitForFunction(() => globalThis.websitesFixture.calls.filter(call => call.method === 'PATCH').length === 2)
    await page.waitForTimeout(100)
    assert.equal(await page.locator('#website-fqdn').inputValue(), 'www.example.com')
    assert.equal(await page.locator('.form-error').count(), 0)
    const finalSites = await page.evaluate(() => globalThis.websitesFixture.server())
    assert.equal(finalSites.find(entry => entry.id === TWO).fqdn, 'www.example.com')
    assert.equal(finalSites.find(entry => entry.id === ONE).fqdn, 'changed.example.com')

    // A save that fails for the previous site must not surface its error on the
    // newly selected site (the guard covers the error write-back too).
    await page.evaluate(() => { globalThis.websitesFixture.holdNext('PATCH'); globalThis.websitesFixture.failNext('PATCH') })
    await page.locator('#website-fqdn').fill('never.example.com')
    await page.getByRole('button', { name: 'Save domain' }).click()
    await page.waitForFunction(() => globalThis.websitesFixture.calls.some(call => call.method === 'PATCH' && call.body?.fqdn === 'never.example.com'))
    await page.evaluate(id => globalThis.websitesFixture.select(id), ONE)
    await page.waitForFunction(() => document.querySelector('[data-testid="website-settings-fqdn"]')?.textContent?.trim() !== 'www.example.com')
    const otherFqdn = await page.getByTestId('website-settings-fqdn').textContent()
    await page.evaluate(() => globalThis.websitesFixture.release())
    await page.waitForFunction(() => globalThis.websitesFixture.calls.filter(call => call.method === 'PATCH').length === 3)
    await page.waitForTimeout(100)
    assert.equal(await page.locator('.form-error').count(), 0)
    assert.equal(await page.locator('#website-fqdn').inputValue(), otherFqdn)

    // A delete whose list refresh fails must not keep presenting the removed
    // site as the editable settings; the retry recovers the list.
    await page.evaluate(() => globalThis.websitesFixture.failNextLoad())
    await page.getByRole('button', { name: 'Delete this website' }).click()
    await page.getByRole('group', { name: 'Confirm deletion of one.example.com' }).waitFor()
    await page.getByRole('button', { name: 'Delete record' }).click()
    await page.getByRole('heading', { name: 'Website deleted' }).waitFor()
    assert.equal(await page.getByTestId('website-settings-fqdn').count(), 0)
    assert.equal(await page.getByRole('heading', { name: 'Domain' }).count(), 0)
    await page.getByRole('button', { name: 'Reload website list' }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="website-settings-fqdn"]')?.textContent?.trim() === 'www.example.com')
    assert.equal(await page.getByRole('heading', { name: 'Domain' }).count(), 1)

    // The settings page never runs the old list read.
    assert.equal(calls.filter(call => call.method === 'GET' && call.url.includes('limit=50')).length, 0)

    // (g) The Add a website section is present at 390px.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('heading', { name: 'Add a website' }).scrollIntoViewIfNeeded()
    assert.equal(await page.getByRole('heading', { name: 'Add a website' }).isVisible(), true)
    assert.equal(await page.getByTestId('new-website-fqdn').isVisible(), true)

    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log('PASS: selected-site settings, domain/GA4 saves, add, delete fallback, no list read, narrow layout')
} finally { await browser.close() }
