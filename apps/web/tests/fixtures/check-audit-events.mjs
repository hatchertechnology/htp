import assert from 'node:assert/strict'
import { chromium } from 'playwright'
// Needs `npm run fixture:bing:serve` (or any fixture vite server). Loopback only.
const base = process.env.BING_FIXTURE_BASE_URL || `http://127.0.0.1:${process.env.BING_FIXTURE_PORT || 4177}`
if (new URL(base).hostname !== '127.0.0.1') throw new Error('Loopback only')
const url = mode => `${base}/tests/fixtures/audit-events.html?mode=${mode}`
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ timezoneId: 'America/New_York', locale: 'en-US' })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'warning' && /Failed to resolve component/.test(message.text())) errors.push(message.text()) })
  const section = page.locator('.audit-events')

  // Default: new/reopened events, local time, notice, safe rendering, older paging.
  await page.goto(url('default'))
  await section.getByRole('heading', { name: 'Alerts and operational history' }).waitFor()
  assert.equal(await section.count(), 1, 'AuditEvents must render')
  await section.getByRole('cell', { name: 'New issue' }).waitFor()
  await section.getByRole('cell', { name: 'Reopened' }).waitFor()
  assert.match(await section.locator('.report-caption').first().innerText(), /local time \(EST\)/)
  const time = section.locator('table').first().locator('time').first()
  assert.equal(await time.getAttribute('datetime'), '2026-11-23T01:30:00+00:00')
  assert.match(await time.innerText(), /Nov 22, 2026.*8:30\s*PM\s*EST/, 'shown in the browser zone, not UTC')
  assert.match(await section.innerText(), /Alert production is not active yet/)
  assert.equal(await section.locator('img').count(), 0, 'markup in data is text, not HTML')
  assert.equal(await page.evaluate(() => window.__xss), undefined)
  await section.getByText('<img src=x onerror="window.__xss=1">').waitFor()
  await section.getByText('Open: not yet recovered').waitFor()
  await section.getByText('Recovered', { exact: true }).waitFor()
  await section.getByRole('button', { name: 'Older events' }).click()
  await section.getByRole('cell', { name: 'Severity increased' }).waitFor()
  assert.equal(await section.getByRole('cell', { name: 'New issue' }).count(), 1, 'older rows are appended')
  assert.equal(await section.getByRole('button', { name: 'Older events' }).count(), 0)
  const calls = await page.evaluate(() => window.__calls.filter(call => call.rpc === 'audit_event_history'))
  assert.equal(calls.at(-1).args.p_before, '2026-11-22T01:30:00+00:00')
  assert.equal(calls.at(-1).args.p_before_id, '20000000-0000-0000-0000-000000000002')

  // A failed older page keeps the rows, says so, and retries the same page.
  await page.goto(url('older-fails'))
  await section.getByRole('button', { name: 'Older events' }).click()
  await section.getByRole('alert').getByText(/not an empty history/).waitFor()
  await section.getByRole('cell', { name: 'New issue' }).waitFor()
  await section.getByRole('button', { name: 'Try again' }).click()
  await section.getByRole('cell', { name: 'Severity increased' }).waitFor()
  assert.equal(await section.getByRole('cell', { name: 'New issue' }).count(), 1, 'retry did not reset to page 1')

  // Empty history is explicit and never a clean result while the producer is off.
  await page.goto(url('empty'))
  await section.getByText(/Event processing is off/).first().waitFor()
  assert.match(await section.innerText(), /empty list of events is not a clean result/)
  assert.doesNotMatch(await section.innerText(), /No audit events are stored/)

  // A malformed page is a read failure, never an empty history.
  await page.goto(url('malformed'))
  await section.getByRole('alert').getByText(/This is not an empty history/).first().waitFor()
  assert.equal(await section.getByText('No audit events are stored for this website.').count(), 0)

  // Only producer_active reads an empty list as "no events"; the active state is a status, not a warning.
  await page.goto(url('active'))
  await section.getByText('Alert production is active.').first().waitFor()
  assert.doesNotMatch(await section.innerText(), /Alert production is not active yet/)
  await page.goto(url('active-empty'))
  await section.getByText('An empty list means no events are stored.').waitFor()
  await section.getByText('No audit events are stored for this website.').waitFor()

  // Every other producer code is a notice; an empty list is never clean and queue counts are shown.
  for (const [mode, lead] of [['not-enqueuing', /not queueing new events/], ['starting', /has not run yet/], ['stale', /not run for at least 5 minutes/], ['degraded', /errors or delays/]]) {
    await page.goto(url(mode))
    await section.getByRole('cell', { name: 'New issue' }).waitFor()
    const text = await section.innerText()
    assert.match(text, lead, mode)
    assert.match(text, /may be missing or delayed/, mode)
    assert.match(text, /4 pending and 2 held for this site/, mode)
    assert.doesNotMatch(text, /An empty list means no events/, mode)
  }
  // An empty list under any other code names that state and never says "none are stored".
  for (const [mode, lead] of [['not-enqueuing-empty', /Not enqueuing yet/], ['starting-empty', /Starting: the runner has not run yet/], ['stale-empty', /Stale: no recent run/], ['degraded-empty', /Degraded: the last run had errors or delays/]]) {
    await page.goto(url(mode))
    await section.getByText(lead).first().waitFor()
    const text = await section.innerText()
    assert.match(text, /empty list of events is not a clean result/, mode)
    assert.doesNotMatch(text, /No audit events are stored/, mode)
    assert.doesNotMatch(text, /No provider failure episodes are stored/, mode)
    assert.doesNotMatch(text, /An empty list means no events/, mode)
  }

  assert.deepEqual(errors, [])
  console.log('AuditEvents fixture passed: events, episodes, local time, safe rendering, paging, retry, malformed, and every producer state including its empty copy.')
} finally { await browser.close() }
