// Static pilot owner workflow: eligibility, hosts/origins, DNS begin/confirm and form save go through the owner API only.
// Synthetic data only. Every request must stay on the fixture origin, and no Supabase table, RPC or Edge Function may run.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.BING_FIXTURE_BASE_URL ?? 'http://127.0.0.1:4177'
const origin = new URL(base).origin
const url = query => new URL('/tests/fixtures/forms.html' + query, base).href
const SITE = '10000000-0000-0000-0000-000000000001'
const FORM = '10000000-0000-0000-0000-000000000002'
const NEW_HOST = '30000000-0000-0000-0000-000000000002'
const TOKEN = 'b'.repeat(64)
const ELIGIBILITY = `GET /websites/${SITE}/forms/pilot-eligibility`
const HOSTS = `GET /websites/${SITE}/forms/hosts?limit=100&offset=0`
const BEGIN = `POST /websites/${SITE}/forms/host-verifications`
const CONFIRM = `POST /forms/host-verifications/${NEW_HOST}/confirm`
const SAVE = `POST /websites/${SITE}/forms`
const ORIGINS = `GET /websites/${SITE}/forms/origins?form_id=${FORM}&limit=100&offset=0`
const RESPONSES = `GET /websites/${SITE}/forms/${FORM}/responses?limit=100&offset=0`

const browser = await chromium.launch({ headless: true })

// Every session records non-fixture http(s) requests and page errors, so a hosted call fails the check.
async function session(query, viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport })
  const hosted = []
  const errors = []
  page.on('request', request => {
    const target = new URL(request.url())
    if ((target.protocol === 'http:' || target.protocol === 'https:') && target.origin !== origin) hosted.push(request.url())
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url(query))
  await page.waitForFunction(() => Boolean(globalThis.formFixture))
  return {
    page, hosted, errors,
    state: () => page.evaluate(() => globalThis.formFixture.state()),
    fail: (route, code, applied) => page.evaluate(([r, c, a]) => globalThis.formFixture.failNext(r, c, a), [route, code ?? undefined, applied === true]),
  }
}
async function closeSession(s) { await s.page.close() }
async function assertClean(s, label) {
  const state = await s.state()
  assert.deepEqual(state.calls, [], `${label}: no Supabase RPC or Edge Function on the static pilot path`)
  assert.deepEqual(state.queries, [], `${label}: no Supabase table read on the static pilot path`)
  assert.deepEqual(s.hosted, [], `${label}: no alternate hosted request`)
  assert.deepEqual(s.errors, [], `${label}: no page error`)
  return state
}

try {
  // 1. Denied pilot (eligibility false or failed): the Forms control stays hidden and only the eligibility read runs.
  for (const scenario of ['no', 'other-site', 'foreign', 'error']) {
    const s = await session(`?mode=pilot&static=1&eligible=${scenario}`)
    await s.page.waitForTimeout(150)
    assert.equal(await s.page.getByRole('button', { name: 'Forms', exact: true }).count(), 0, `${scenario} must stay hidden`)
    const state = await assertClean(s, scenario)
    assert.ok(state.apiCalls.every(call => call === ELIGIBILITY), `${scenario}: only the eligibility read may run, got ${state.apiCalls.join(', ')}`)
    await closeSession(s)
  }

  // 2. Stale session: an owner change while eligibility is pending hides the control.
  for (const operation of ['setOwner', 'setAnonymous']) {
    const s = await session('?mode=pilot&static=1&eligible=slow')
    await s.page.evaluate(op => (op === 'setOwner' ? globalThis.formFixture.setOwner(null) : globalThis.formFixture.setAnonymous()), operation)
    await s.page.waitForTimeout(700)
    assert.equal(await s.page.getByRole('button', { name: 'Forms', exact: true }).count(), 0, `${operation} must hide`)
    await closeSession(s)
  }

  // 3. Eligible pilot, normal setup: verify a host, save a form, edit it, read responses. Owner API only.
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const s = await session('?mode=pilot&static=1&eligible=yes', viewport)
    await s.page.getByRole('button', { name: 'Forms', exact: true }).click()
    await s.page.getByRole('button', { name: 'Create DNS challenge' }).click()
    await s.page.getByText('_htp-verification.www.example.com', { exact: true }).waitFor()
    await s.page.getByRole('button', { name: 'Verify DNS record' }).click()
    await s.page.getByText('Host verified.', { exact: true }).waitFor()
    await s.page.getByLabel('Form name').fill('New form')
    await s.page.getByLabel('Form key').fill('new_form')
    await s.page.getByRole('button', { name: 'Save form' }).click()
    await s.page.getByText('Form saved.', { exact: true }).waitFor()
    await s.page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await s.page.getByRole('button', { name: 'Save form' }).click()
    await s.page.getByText('Form saved.', { exact: true }).waitFor()
    await s.page.getByRole('button', { name: 'Responses', exact: true }).first().click()
    await s.page.getByText('<script>unsafe</script>', { exact: true }).waitFor()
    assert.equal(await s.page.locator('#app script').count(), 0)
    assert.equal(await s.page.getByRole('button', { name: 'Export all CSV' }).isEnabled(), true)
    for (const name of ['Mark reviewed', 'Mark spam', 'Delete', 'Send verification', 'Disable', 'Retry']) {
      assert.equal(await s.page.getByRole('button', { name, exact: true }).count(), 0, `${name} is held`)
    }
    const state = await assertClean(s, `eligible ${viewport.width}px`)
    for (const call of [ELIGIBILITY, HOSTS, BEGIN, CONFIRM, SAVE, ORIGINS, RESPONSES]) assert.ok(state.apiCalls.includes(call), `missing ${call}`)
    const [begin] = state.bodies.filter(entry => entry.method === 'POST' && entry.path.endsWith('/host-verifications'))
    assert.deepEqual(begin.body, { hostname: 'www.example.com' }, 'begin sends only the exact hostname')
    const [confirm] = state.bodies.filter(entry => entry.path.endsWith('/confirm'))
    assert.deepEqual(confirm.body, { token: TOKEN }, 'confirm sends only the issued token')
    const saves = state.bodies.filter(entry => entry.method === 'POST' && entry.path === `/websites/${SITE}/forms`)
    assert.equal(saves.length, 2)
    assert.equal('form_id' in saves[0].body, false, 'create sends no form_id')
    assert.equal(saves[0].body.form_key, 'new_form')
    assert.equal(saves[1].body.form_id, FORM, 'update sends the existing form_id')
    await closeSession(s)
  }

  // 4. Ambiguous and refused outcomes are never reported as plain failures.
  {
    // A begin transport failure reads as unknown, and a fresh challenge can be requested after reload.
    const s = await session('?mode=pilot&static=1&eligible=yes')
    await s.page.getByRole('button', { name: 'Forms', exact: true }).click()
    await s.fail('begin')
    await s.page.getByRole('button', { name: 'Create DNS challenge' }).click()
    await s.page.getByText(/may or may not have been created/).waitFor()
    await s.page.getByRole('button', { name: 'Create DNS challenge' }).click()
    await s.page.getByText('_htp-verification.www.example.com', { exact: true }).waitFor()
    await assertClean(s, 'begin unknown')
    await closeSession(s)
  }
  {
    // Confirm committed but the response was lost: reconciliation finds the host verified and closes the challenge.
    const s = await session('?mode=pilot&static=1&eligible=yes')
    await s.page.getByRole('button', { name: 'Forms', exact: true }).click()
    await s.page.getByRole('button', { name: 'Create DNS challenge' }).click()
    await s.page.getByText('_htp-verification.www.example.com', { exact: true }).waitFor()
    await s.fail('confirm', undefined, true)
    await s.page.getByRole('button', { name: 'Verify DNS record' }).click()
    await s.page.getByText('Host verified.', { exact: true }).waitFor()
    assert.equal(await s.page.getByRole('button', { name: 'Verify DNS record' }).count(), 0)
    await assertClean(s, 'confirm applied')
    await closeSession(s)
  }
  {
    // Confirm outcome unknown and not applied: verify stays off until the page is reloaded, and no token is re-sent.
    const s = await session('?mode=pilot&static=1&eligible=yes')
    await s.page.getByRole('button', { name: 'Forms', exact: true }).click()
    await s.page.getByRole('button', { name: 'Create DNS challenge' }).click()
    await s.page.getByText('_htp-verification.www.example.com', { exact: true }).waitFor()
    await s.fail('confirm')
    await s.page.getByRole('button', { name: 'Verify DNS record' }).click()
    await s.page.getByText(/Verification status is unknown/).waitFor()
    assert.equal(await s.page.getByRole('button', { name: 'Verify DNS record' }).isDisabled(), true)
    assert.equal(await s.page.getByRole('button', { name: 'Create DNS challenge' }).isDisabled(), true)
    const state = await assertClean(s, 'confirm unknown')
    assert.equal(state.apiCalls.filter(call => call === CONFIRM).length, 1, 'confirm is not retried')
    await closeSession(s)
  }
  {
    // A save transport failure on create is unknown: the form is not retried, and Save stays off.
    const s = await session('?mode=pilot&static=1&eligible=yes')
    await s.page.getByRole('button', { name: 'Forms', exact: true }).click()
    await s.fail('save')
    await s.page.getByLabel('Form name').fill('New form')
    await s.page.getByLabel('Form key').fill('new_form')
    await s.page.getByRole('button', { name: 'Save form' }).click()
    await s.page.getByText(/may or may not have been saved/).waitFor()
    assert.equal(await s.page.getByRole('button', { name: 'Save form' }).isDisabled(), true)
    const state = await assertClean(s, 'save unknown')
    assert.equal(state.apiCalls.filter(call => call === SAVE).length, 1, 'save is not retried')
    await closeSession(s)
  }
  {
    // Definite refusals report the stable message and nothing is treated as written.
    const s = await session('?mode=pilot&static=1&eligible=yes')
    await s.page.getByRole('button', { name: 'Forms', exact: true }).click()
    await s.fail('begin', 'host_limit')
    await s.page.getByRole('button', { name: 'Create DNS challenge' }).click()
    await s.page.getByText('This website has reached its limit of 64 hosts.', { exact: true }).waitFor()
    await s.fail('save', 'invalid_request')
    await s.page.getByLabel('Form name').fill('Refused')
    await s.page.getByLabel('Form key').fill('refused_form')
    await s.page.getByRole('button', { name: 'Save form' }).click()
    await s.page.getByText('The form was refused. Check the name, key, fields and verified hosts.', { exact: true }).waitFor()
    assert.equal(await s.page.getByRole('button', { name: 'Save form' }).isDisabled(), false)
    await assertClean(s, 'definite refusals')
    await closeSession(s)
  }

  await browser.close()
  console.log('PASS: static pilot owner workflow uses only the owner API, with eligible, denied, stale, and unknown-outcome paths')
} catch (error) {
  await browser.close()
  throw error
}
