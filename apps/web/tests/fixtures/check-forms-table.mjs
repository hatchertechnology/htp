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
    const beforeDateRows = await page.locator('tbody tr').count()
    await page.getByLabel(/Received from/).fill('2026-11-24')
    await page.getByLabel(/Received to/).fill('2026-11-24')
    await page.getByRole('cell', { name: 'Local day insider', exact: true }).waitFor()
    await page.waitForFunction(expected => document.querySelectorAll('tbody tr').length < expected, beforeDateRows)
    const dayRows = await page.locator('tbody tr').count()
    assert.ok(dayRows > 0 && dayRows < beforeDateRows, 'the local-day filter reduces the row count')
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

    // Status filter: spam only. Clearing the last checked status keeps it
    // applied, and the checkbox must snap back to match the filter.
    await page.getByRole('checkbox', { name: 'New', exact: true }).uncheck()
    await page.getByRole('checkbox', { name: 'Reviewed', exact: true }).uncheck()
    values = await statuses(page)
    assert.ok(values.length > 0 && values.every(value => value === 'spam'))
    const spamBox = page.getByRole('checkbox', { name: 'Spam', exact: true })
    await spamBox.click()
    assert.equal(await spamBox.isChecked(), true, 'the last status checkbox remains checked')
    values = await statuses(page)
    assert.ok(values.length > 0 && values.every(value => value === 'spam'), 'spam remains the applied filter')
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

    // Bulk status acts on every selected loaded row, including a selection that
    // spans the first API page boundary (row 0 and row 120 of 150).
    const boxes = page.getByRole('checkbox', { name: /^Select response received/ })
    await boxes.nth(0).check()
    await boxes.nth(120).check()
    await page.getByText('2 selected', { exact: true }).waitFor()
    await page.getByRole('group', { name: 'Bulk response actions' }).getByRole('button', { name: 'Mark reviewed' }).click()
    await page.waitForFunction(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH').length === 2)
    let patches = await page.evaluate(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH'))
    assert.deepEqual(patches.map(entry => entry.body), [{ status: 'reviewed' }, { status: 'reviewed' }])
    assert.equal(new Set(patches.map(entry => entry.path)).size, 2, 'both selected rows were patched across the page boundary')
    await page.getByText('2 responses marked reviewed.', { exact: true }).waitFor()

    // Mark spam uses the same all-selected path.
    await boxes.nth(0).check()
    await page.getByRole('group', { name: 'Bulk response actions' }).getByRole('button', { name: 'Mark spam' }).click()
    await page.waitForFunction(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH').length === 3)
    patches = await page.evaluate(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH'))
    assert.deepEqual(patches[2].body, { status: 'spam' })
    await page.getByText('1 response marked spam.', { exact: true }).waitFor()

    // An injected unknown outcome stops the sequence, reports counts and keeps the lock.
    await boxes.nth(0).check()
    await boxes.nth(1).check()
    await page.evaluate(() => globalThis.formFixture.failNext('response'))
    await page.getByRole('group', { name: 'Bulk response actions' }).getByRole('button', { name: 'Mark reviewed' }).click()
    await page.getByRole('alert').filter({ hasText: 'outcome is unknown' }).waitFor()
    await page.waitForFunction(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH').length === 4)
    patches = await page.evaluate(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH'))
    assert.equal(patches.length, 4, 'the sequence stops after the unknown outcome')
    await page.getByText('Bulk status: 0 succeeded, 0 failed, 1 unknown, 1 not attempted.', { exact: true }).waitFor()
    assert.equal(await boxes.nth(0).isDisabled(), true)
    await page.locator('summary').filter({ hasText: 'Actions' }).first().click()
    assert.equal(await page.getByRole('button', { name: 'Mark reviewed' }).last().isDisabled(), true)

    assert.deepEqual(errors, [])
    await context.close()

    // A definite refusal also stops the sequence and reports the counts.
    const refused = await open(viewport)
    const refusedBoxes = refused.page.getByRole('checkbox', { name: /^Select response received/ })
    await refusedBoxes.nth(0).check()
    await refusedBoxes.nth(1).check()
    await refused.page.evaluate(() => globalThis.formFixture.failNext('response', 'invalid_request'))
    await refused.page.getByRole('group', { name: 'Bulk response actions' }).getByRole('button', { name: 'Mark reviewed' }).click()
    await refused.page.getByRole('alert').filter({ hasText: /refused|unavailable/i }).waitFor()
    await refused.page.waitForFunction(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH').length === 1)
    await refused.page.getByText('Bulk status: 0 succeeded, 1 failed, 0 unknown, 1 not attempted.', { exact: true }).waitFor()
    assert.deepEqual(refused.errors, [])
    await refused.context.close()

    // No 100-row cap: select all 150 loaded rows and act on every one.
    if (viewport.width === 1280) {
      const many = await open(viewport)
      await many.page.getByRole('button', { name: 'Load next 100' }).click()
      await many.page.getByText(/More responses exist/).waitFor({ state: 'detached' })
      await many.page.getByRole('checkbox', { name: 'Select all visible responses' }).check()
      await many.page.getByText('150 selected', { exact: true }).waitFor()
      await many.page.getByRole('group', { name: 'Bulk response actions' }).getByRole('button', { name: 'Mark reviewed' }).click()
      await many.page.waitForFunction(() => globalThis.formFixture.state().bodies.filter(entry => entry.method === 'PATCH').length === 150, undefined, { timeout: 60000 })
      await many.page.getByText('150 responses marked reviewed.', { exact: true }).waitFor()
      assert.deepEqual(many.errors, [])
      await many.context.close()
    }
  }

  console.log('PASS: submissions table local time, sort, filters, search, paging, CSV and all-selected bulk status at both viewports')
} finally {
  await browser.close()
}
