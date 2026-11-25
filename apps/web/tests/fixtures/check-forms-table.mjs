import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.BING_FIXTURE_BASE_URL ?? 'http://127.0.0.1:4177'
const url = new URL('/tests/fixtures/forms.html?mode=pilot&static=1&eligible=yes&responses=1&rows=150', base).href
const browser = await chromium.launch({ headless: true })

async function open(viewport) {
  const context = await browser.newContext({ viewport, timezoneId: 'America/New_York', acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.getByRole('tab', { name: 'Responses' }).waitFor()
  await page.getByRole('columnheader', { name: 'Received' }).waitFor()
  return { context, page, errors }
}
const statuses = async page => page.locator('td.status-cell').allTextContents().then(values => values.map(value => value.trim()))
const rank = status => ({ new: 0, reviewed: 1, spam: 2 })[status]
async function waitForStatusOrder(page) {
  await page.waitForFunction(() => {
    const order = { new: 0, reviewed: 1, spam: 2 }
    const values = [...document.querySelectorAll('td.status-cell')].map(cell => cell.textContent.trim())
    return values.every((value, index) => index === 0 || order[values[index - 1]] <= order[value])
  })
}
async function waitForScoreOrder(page) {
  await page.waitForFunction(() => {
    const values = [...document.querySelectorAll('tbody tr')].map(row => {
      const cells = [...row.querySelectorAll('td.value-cell')]
      return Number(cells[cells.length - 1]?.textContent?.trim() ?? '')
    })
    return values.every((value, index) => index === 0 || values[index - 1] <= value)
  })
}

try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const { context, page, errors } = await open(viewport)

    // Local-time display keeps the UTC ISO value in datetime/title.
    const insider = page.locator('time[datetime="2026-11-25T03:00:00Z"]')
    await insider.waitFor()
    assert.match(await insider.textContent(), /Nov 24, 2026/)
    assert.match(await insider.textContent(), /EST/)
    assert.equal(await insider.getAttribute('title'), '2026-11-25T03:00:00Z')
    assert.equal(await page.getByRole('cell',{name:'<script>unsafe</script>',exact:true}).count(), 1)
    assert.equal(await page.locator('#app script').count(), 0)

    // Default sort is Received descending.
    assert.equal(await page.getByRole('columnheader', { name: 'Received' }).getAttribute('aria-sort'), 'descending')

    // The local-day From/To filter converts Nov 24 to UTC instants.
    await page.getByLabel(/Received from/).fill('2026-11-24')
    await page.getByLabel(/Received to/).fill('2026-11-24')
    await page.getByRole('cell', { name: 'Local day insider', exact: true }).waitFor()
    assert.equal(await page.getByRole('cell', { name: 'Before local day', exact: true }).count(), 0)
    await page.getByLabel(/Received from/).fill('')
    await page.getByLabel(/Received to/).fill('')
    await page.getByRole('cell', { name: 'Before local day', exact: true }).waitFor()

    // Status and field header sorting.
    await page.getByRole('columnheader', { name: 'Status' }).getByRole('button').click()
    assert.equal(await page.getByRole('columnheader', { name: 'Status' }).getAttribute('aria-sort'), 'ascending')
    await waitForStatusOrder(page)
    let values = await statuses(page)
    assert.deepEqual(values, [...values].sort((a, b) => rank(a) - rank(b)))
    await page.getByRole('columnheader', { name: 'score' }).getByRole('button').click()
    assert.equal(await page.getByRole('columnheader', { name: 'score' }).getAttribute('aria-sort'), 'ascending')
    await waitForScoreOrder(page)
    // Column order is Name, note, score; read the last value cell per row.
    const rowScores = await page.locator('tbody tr').evaluateAll(rows => rows.map(row => {
      const cells = [...row.querySelectorAll('td.value-cell')]
      return Number(cells[cells.length - 1]?.textContent?.trim() ?? '')
    }))
    assert.deepEqual(rowScores, [...rowScores].sort((a, b) => a - b))

    // Status filter: spam only.
    await page.getByRole('checkbox', { name: 'New', exact: true }).uncheck()
    await page.getByRole('checkbox', { name: 'Reviewed', exact: true }).uncheck()
    values = await statuses(page)
    assert.ok(values.length > 0 && values.every(value => value === 'spam'))
    await page.getByRole('checkbox', { name: 'New', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Reviewed', exact: true }).check()

    // Search values only, case-insensitively.
    await page.getByLabel('Search responses').fill('local DAY insider')
    await page.getByRole('cell', { name: 'Local day insider', exact: true }).waitFor()
    assert.equal(await page.getByRole('cell', { name: 'Before local day', exact: true }).count(), 0)
    assert.equal(await page.locator('tbody tr').count(), 1)
    await page.getByLabel('Search responses').fill('')

    // Partial-data notice: visible while the API has another page, gone after loading it.
    await page.getByText(/More responses exist/).waitFor()
    await page.getByRole('button', { name: 'Load next 100' }).click()
    await page.getByText(/More responses exist/).waitFor({ state: 'detached' })
    assert.equal(await page.locator('tbody tr').count(), 150)

    // CSV keeps UTC ISO received_at and prefixes formula values.
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export all responses (CSV)' }).click()
    const download = await downloadPromise
    const csv = await readFile(await download.path(), 'utf8')
    assert.match(csv, /"received_at","status","name"/)
    assert.match(csv, /score/)
    assert.match(csv, /note/)
    assert.ok(csv.includes('2026-11-25T03:00:00Z'))
    assert.ok(csv.includes('"\'=HYPERLINK'), 'formula value must be prefixed')

    // Return to Received descending so the first selected rows stay on the first API page.
    await page.getByRole('columnheader', { name: 'Received' }).getByRole('button').click()
    await page.waitForFunction(() => document.querySelector('th[aria-sort="descending"] button')?.textContent?.trim() === 'Received')

    // Bulk status sends sequential PATCH bodies for selected visible rows.
    const boxes = page.getByRole('checkbox', { name: /^Select response received/ })
    await boxes.nth(0).check()
    await boxes.nth(1).check()
    await boxes.nth(2).check()
    await page.getByRole('group', { name: 'Bulk response actions' }).getByRole('button', { name: 'Mark reviewed' }).click()
    await page.waitForFunction(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH').length === 3)
    let bodies = await page.evaluate(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH').map(entry => entry.body))
    assert.deepEqual(bodies, [{ status: 'reviewed' }, { status: 'reviewed' }, { status: 'reviewed' }])

    // An injected unknown outcome stops the sequence and keeps the lock.
    await boxes.nth(0).check()
    await boxes.nth(1).check()
    await page.evaluate(() => globalThis.formFixture.failNext('response'))
    await page.getByRole('group', { name: 'Bulk response actions' }).getByRole('button', { name: 'Mark reviewed' }).click()
    await page.getByRole('alert').filter({ hasText: 'outcome is unknown' }).waitFor()
    await page.waitForFunction(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH').length === 4)
    bodies = await page.evaluate(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH').map(entry => entry.body))
    assert.equal(bodies.length, 4, 'the sequence stops after the unknown outcome')
    assert.equal(await boxes.nth(0).isDisabled(), true)
    await page.locator('summary').filter({ hasText: 'Actions' }).first().click()
    assert.equal(await page.getByRole('button', { name: 'Mark reviewed' }).last().isDisabled(), true)

    assert.deepEqual(errors, [])
    await context.close()
  }

  console.log('PASS: submissions table local time, sort, filters, search, paging, CSV and bulk status at both viewports')
} finally {
  await browser.close()
}
