import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.BING_FIXTURE_BASE_URL ?? 'http://127.0.0.1:4177'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const summary = page.locator('[aria-label="Bing traffic summary"]')
const metric = name => summary.locator('.summary-panel').filter({ hasText: name }).locator('strong')
async function value(name, expected) {
  await metric(name).waitFor({ state: 'visible' })
  await page.waitForFunction(([label, value]) => {
    const cards = [...document.querySelectorAll('[aria-label="Bing traffic summary"] .summary-panel')]
    return cards.find(card => card.textContent?.includes(label))?.querySelector('strong')?.textContent?.trim() === value
  }, [name, expected])
  assert.equal((await metric(name).textContent())?.trim(), expected)
}
async function state(name) {
  await page.evaluate(state => globalThis.setFixture(state), name)
}
try {
  await page.goto(new URL('/tests/fixtures/bing-dashboard.html', base).href)
  await page.getByText('Stored coverage:').waitFor()
  assert.match(await page.getByRole('status').first().innerText(), /partial.*2026-10-03/s)
  assert.match(await page.getByRole('status').first().innerText(), /Connect Bing/)
  await value('Bing clicks', '2'); await value('Bing impressions', '10')
  await state('failure')
  await page.getByText('The latest Bing traffic collection failed.', { exact: false }).waitFor()
  await value('Bing clicks', '2'); await value('Bing impressions', '10')
  await state('no-match')
  await page.getByText('The latest Bing traffic collection failed.', { exact: false }).waitFor({ state: 'hidden' })
  assert.equal(await page.getByText('https://example.com/', { exact: true }).count(), 1)
  await value('Bing clicks', '2'); await value('Bing impressions', '10')
  await state('rebind')
  await page.getByText('https://new.example.com/', { exact: true }).waitFor()
  await value('Bing clicks', '99'); await value('Bing impressions', '100')
  assert.equal(await page.getByText('https://example.com/', { exact: true }).count(), 0)
  assert.deepEqual(errors, [])
  console.log('PASS: actual Bing dashboard renders partial disconnected, failed collection, retained no-match and rebound source states with expected traffic values')
} finally { await browser.close() }
