import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser = await chromium.launch({headless: true})
try {
  for (const mode of [0, 1]) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(new URL(`/tests/fixtures/repository-owner.html?static=${mode}`, process.env.BING_FIXTURE_BASE_URL ?? 'http://127.0.0.1:4177').href)
    await page.getByText('Selected: example.test', {exact: true}).waitFor()
    await page.getByText('Fixture commit 2', {exact: true}).waitFor()
    await page.getByRole('button', {name: 'Load older observations'}).click()
    await page.getByText('Fixture commit 1', {exact: true}).waitFor()
    await page.getByRole('button', {name: 'Load more issues'}).click()
    await page.getByText('#2 · Fixture open issue 2', {exact: true}).waitFor()
    await page.getByLabel('Issue status').selectOption('closed')
    await page.getByText('#1 · Fixture closed issue 1', {exact: true}).waitFor()
    await page.getByText('GitHub repository for example.test', {exact: true}).click()
    await page.getByRole('button', {name: 'Save repository', exact: true}).click()
    await page.getByText('Repository saved.', {exact: false}).waitFor()
    await page.getByRole('button', {name: 'Stop collection', exact: true}).click()
    await page.getByText('Collection stopped.', {exact: false}).waitFor()
    const calls = await page.evaluate(() => globalThis.repositoryFixture.calls)
    const owner = calls.filter(call => call.url.includes('/websites'))
    assert.ok(owner.length >= 9)
    for (const call of owner) {
      assert.ok(call.url.startsWith(mode ? 'https://api.example.test/websites' : '/api/websites'))
      assert.equal(call.options.headers.Authorization, 'Bearer fixture-token')
      assert.equal(call.options.retry, 0)
    }
    assert.ok(owner.some(call => call.options.query?.before_id === 2))
    assert.ok(owner.some(call => call.options.query?.page === 2))
    assert.ok(owner.some(call => call.options.query?.state === 'closed'))
    const writes = owner.filter(call => call.options.method === 'PUT')
    assert.deepEqual(writes.map(call => call.options.body), [
      {repository_url: 'https://github.com/example/site', branch: null, enabled: true},
      {repository_url: null, branch: null, enabled: true},
    ])
    await page.evaluate(() => globalThis.repositoryFixture.signOut())
    await page.getByText('Sign in and select a website to see its HTP issues.').waitFor()
    assert.deepEqual(errors, [])
    await page.close()
  }
  console.log('PASS: repository settings/save/stop, history cursor, issues pagination/filter, workspace list, bearer and legacy/static routing')
} finally {await browser.close()}
