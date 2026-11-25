// Part B shell fixture: sign-in redirect, public routes, persisted context,
// rolling range, pill/account removal and the single site selector. Runs
// against the static artifact served by `npm run static:serve` (wrangler dev,
// port 8788; loopback only, override with HTP_SHELL_ORIGIN).
//
// `NUXT_PUBLIC_ROLLOUT_FORMS_PILOT=true` at build time + HTP_SHELL_EXPECT_FORMS=1
// checks the Forms nav item is present; the default artifact asserts it is not.
import { chromium } from 'playwright'

const origin = process.env.HTP_SHELL_ORIGIN || 'http://127.0.0.1:8788'
const target = new URL(origin)
if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('This test only runs against loopback HTTP.')
const expectForms = process.env.HTP_SHELL_EXPECT_FORMS === '1'

const OWNER1 = '00000000-0000-0000-0000-000000000001'
const OWNER2 = '00000000-0000-0000-0000-000000000002'
const SITE1 = '00000000-0000-0000-0000-00000000000a'
const SITE2 = '00000000-0000-0000-0000-00000000000b'
const STALE = '00000000-0000-0000-0000-00000000000f'
const EMAIL1 = 'owner1@example.test'
const EMAIL2 = 'owner2@example.test'
const CLOCK_BASE = Date.parse('2026-11-25T03:00:00Z') // local Nov 24, 22:00 in America/New_York

const failures = []
const pageErrors = []
const foreignHosts = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

function sessionToken(sub, email) {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400
  const head = Buffer.from('{}').toString('base64url')
  const body = Buffer.from(JSON.stringify({ sub, exp })).toString('base64url')
  return { token: `${head}.${body}.fake`, exp }
}

const supabaseUser = (sub, email) => ({ id: sub, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {} })

function apiJson(data, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(data), headers: { 'access-control-allow-origin': '*' } }
}

// Intercepts every external request the artifact could make. The workspace API
// returns two synthetic sites and 404s for report payloads; the auth token
// grants return synthetic sessions. Any other host fails the run.
function intercept(page, owner, email, apiLog) {
  const foreign = []
  page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.hostname === target.hostname) return route.continue()
    const path = url.pathname, json = data => route.fulfill(apiJson(data))
    if (url.hostname === 'raxuvdbdfmmtpqjcafcq.supabase.co') {
      if (path === '/auth/v1/token') {
        const grant = url.searchParams.get('grant_type')
        if (grant === 'password') {
          const body = route.request().postDataJSON() || {}
          const sub = body.email === EMAIL2 ? OWNER2 : OWNER1
          const mail = body.email === EMAIL2 ? EMAIL2 : EMAIL1
          const { token, exp } = sessionToken(sub, mail)
          return route.fulfill(apiJson({ access_token: token, refresh_token: 'fake', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: supabaseUser(sub, mail) }))
        }
        const { token, exp } = sessionToken(owner, email)
        return route.fulfill(apiJson({ access_token: token, refresh_token: 'fake', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: supabaseUser(owner, email) }))
      }
      return json({})
    }
    if (url.hostname === 'htp-api-kerry-hatcher.fly.dev') {
      apiLog.push(url.pathname + url.search)
      if (path === '/websites') return json({ items: [{ id: SITE1, fqdn: 'first.example.com' }, { id: SITE2, fqdn: 'second.example.com' }], has_more: false })
      // Static owner paths drop the /api prefix (resolveWorkspaceOwnerPath).
      if (path === '/providers/google/connection') return json({ connected: false, configured: true, analytics: false, search: false, business: false, reauthorizationRequired: false })
      if (path === '/providers/bing/connection') return json({ connected: false, configured: true, reauthorizationRequired: false })
      return route.fulfill(apiJson({ error: 'not available in this fixture' }, 404))
    }
    foreignHosts.push(`${width}px ${url.hostname}${path}`)
    return route.fulfill(apiJson({ error: 'unexpected host' }, 404))
  })
  return foreign
}

function signedInScript(owner, email) {
  const { token, exp } = sessionToken(owner, email)
  return { token, exp, email, owner }
}

async function newPage(browser, { width, height, owner, email, storageSeed, clock } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'America/New_York' })
  const apiLog = []
  const page = await context.newPage()
  page.on('pageerror', e => pageErrors.push(`${width}px: ${e.message.slice(0, 200)}`))
  const foreign = intercept(page, owner ?? OWNER1, email ?? EMAIL1, apiLog)
  if (owner) {
    const session = signedInScript(owner, email)
    await page.addInitScript(({ token, exp, user }) => {
      localStorage.setItem('sb-raxuvdbdfmmtpqjcafcq-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fake', token_type: 'bearer', expires_in: 3600, expires_at: exp, user }))
    }, { token: session.token, exp: session.exp, user: supabaseUser(owner, email) })
  }
  if (storageSeed) {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), storageSeed)
  }
  if (clock) await page.clock.install({ time: clock })
  void foreign
  return { context, page, apiLog }
}

const workspaceKey = owner => `htp:workspace:v1:${owner}`

const redirectPath = async (page, pathname, timeout = 15000) => {
  // Poll page.url(): a full navigation after installing waitForFunction can
  // leave the predicate stranded in the previous execution context.
  const deadline = Date.now() + timeout
  const pathOf = url => { const p = new URL(url).pathname; return p.length > 1 ? p.replace(/\/+$/, '') : p }
  while (Date.now() < deadline) {
    if (pathOf(page.url()) === pathname) return new URL(page.url())
    await page.waitForTimeout(200)
  }
  throw new Error(`redirect to ${pathname} timed out at ${page.url()}`)
}


// 1. Sign-in redirect and return path (both viewports).
async function stepSignIn(browser, width, height) {
  const s = await newPage(browser, { width, height })
  await s.page.goto(`${origin}/websites/?tab=x`)
  await s.page.waitForURL(/\/sign-in/, { timeout: 30000 })
  const url = new URL(s.page.url())
  check(`sign-in redirect (${width})`, url.pathname === '/sign-in' && url.searchParams.get('redirect') === '/websites/?tab=x', s.page.url())
  await s.page.getByLabel('Email').fill(EMAIL1)
  await s.page.getByRole('textbox', { name: 'Password' }).fill('sup3rsecret')
  await s.page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const landed = redirectPath(s.page, '/websites')
  const landedUrl = (await landed)
  check(`sign-in submit returns to the requested page (${width})`, landedUrl.pathname.replace(/\/$/, '') === '/websites' && landedUrl.searchParams.get('tab') === 'x', `${landedUrl.href}`)

  // Open-redirect probes: a signed-in visit to /sign-in with a bad redirect lands on '/'.
  for (const probe of ['//evil.test', 'https://evil.test', '/\\evil.test', 'javascript:alert(1)']) {
    await s.page.goto(`${origin}/sign-in?redirect=${encodeURIComponent(probe)}`, { waitUntil: 'load' })
    check(`open-redirect blocked (${width}) ${probe}`, (await redirectPath(s.page, '/')).pathname === '/', s.page.url())
  }
  // A valid return path is honoured.
  await s.page.goto(`${origin}/sign-in?redirect=${encodeURIComponent('/connections')}`, { waitUntil: 'load' })
  check(`valid return path honoured (${width})`, (await redirectPath(s.page, '/connections')).pathname === '/connections', s.page.url())
  await s.context.close()
}

// 2. Public routes stay reachable signed out.
async function stepPublic(browser) {
  const s = await newPage(browser, { width: 1280, height: 800 })
  await s.page.goto(`${origin}/forms/confirm#r:t`)
  await s.page.getByRole('heading', { name: 'Form notifications' }).waitFor({ timeout: 30000 })
  check('forms confirm stays public with its hash', new URL(s.page.url()).pathname.replace(/\/$/, '') === '/forms/confirm', s.page.url())
  await s.page.goto(`${origin}/oauth/consent?authorization_id=abc123`)
  const review = s.page.getByRole('link', { name: 'Sign in to review' })
  await review.waitFor({ timeout: 30000 })
  const href = await review.getAttribute('href')
  // The artifact's auto-trailing-slash may normalise the consent path; the href
  // must carry the page's actual fullPath back to /sign-in.
  const here = new URL(s.page.url())
  check('consent shows sign-in CTA with encoded return path', href === `/sign-in?redirect=${encodeURIComponent(here.pathname + here.search)}`, String(href))
  await s.context.close()
}

// 3. Selection persists per owner; stale IDs fall back.
async function stepSelection(browser) {
  const s = await newPage(browser, { width: 1280, height: 800, owner: OWNER1, email: EMAIL1 })
  await s.page.goto(`${origin}/`)
  const select = s.page.getByLabel('Select website')
  await select.selectOption(SITE2)
  await s.page.reload({ waitUntil: 'load' })
  await s.page.waitForFunction(site => document.querySelector('select[aria-label="Select website"]')?.value === site, SITE2, { timeout: 30000 })
  const stored = await s.page.evaluate(key => localStorage.getItem(key), workspaceKey(OWNER1))
  let parsed = null
  try { parsed = JSON.parse(stored) } catch { /* checked below */ }
  check('selection persists across reload', (await select.inputValue()) === SITE2 && parsed?.websiteId === SITE2, stored ?? 'missing')
  check('storage holds only version/websiteId/range', JSON.stringify(Object.keys(parsed ?? {}).sort()) === JSON.stringify(['range', 'version', 'websiteId']), JSON.stringify(parsed))

  // Per-user: owner 2 never inherits owner 1's stored choice.
  const s2 = await newPage(browser, { width: 1280, height: 800, owner: OWNER2, email: EMAIL2 })
  await s2.page.goto(`${origin}/`)
  // Owner 2 has no stored context: the selection falls back to the first site.
  await s2.page.waitForFunction(site => { const el = document.querySelector('select[aria-label="Select website"]'); return !!el && !el.disabled && el.value === site }, SITE1, { timeout: 30000 })
  const owner2Stored = await s2.page.evaluate(key => localStorage.getItem(key), workspaceKey(OWNER2))
  check('per-user storage: owner 2 falls back to site 1, not owner 1\'s choice', owner2Stored?.includes(SITE1) === true && !owner2Stored.includes(SITE2), owner2Stored ?? 'missing')
  await s2.context.close()

  // Stale stored site: falls back to site 1, storage overwritten, and no API
  // URL ever carries the unknown ID.
  const s3 = await newPage(browser, { width: 1280, height: 800, owner: OWNER1, email: EMAIL1, storageSeed: { key: workspaceKey(OWNER1), value: JSON.stringify({ version: 1, websiteId: STALE, range: { kind: 'preset', days: 30 } }) } })
  await s3.page.goto(`${origin}/websites/`)
  await s3.page.waitForFunction(site => { const el = document.querySelector('select[aria-label="Select website"]'); return !!el && !el.disabled && el.value === site }, SITE1, { timeout: 30000 })
  const staleStored = await s3.page.evaluate(key => localStorage.getItem(key), workspaceKey(OWNER1))
  check('stale stored site falls back and is overwritten', !staleStored.includes(STALE), staleStored ?? 'missing')
  check('no API URL contains the stale ID', !s3.apiLog.some(u => u.includes(STALE)), s3.apiLog.filter(u => u.includes(STALE)).join(','))
  await s3.context.close()
  await s.context.close()
}

// 4. The rolling range: shortcut pressed, label updates, custom stays fixed.
async function stepRange(browser) {
  const s = await newPage(browser, { width: 1280, height: 800, owner: OWNER1, email: EMAIL1, clock: new Date(CLOCK_BASE) })
  await s.page.goto(`${origin}/`)
  const shortcut = s.page.getByRole('button', { name: 'Last 30 days', exact: true })
  await shortcut.waitFor({ timeout: 30000 })
  await shortcut.click()
  check('Last 30 days shortcut becomes pressed', (await shortcut.getAttribute('aria-pressed')) === 'true')
  const value = s.page.locator('.range-value')
  const label1 = await value.innerText()
  check('range label names the rolling window', /Last 30 days · Oct 26 – Nov 24/.test(label1), label1)
  await s.page.reload({ waitUntil: 'load' })
  await s.page.locator('.range-value').waitFor({ timeout: 30000 })
  const shortcut2 = s.page.getByRole('button', { name: 'Last 30 days', exact: true })
  check('rolling preset persists across reload', (await shortcut2.getAttribute('aria-pressed')) === 'true' && /Last 30 days · Oct 26 – Nov 24/.test(await s.page.locator('.range-value').innerText()))

  // Advance one UTC day: a preset rolls, both dates move by one.
  await s.page.clock.setFixedTime(new Date(CLOCK_BASE + 86400_000))
  await s.page.reload({ waitUntil: 'load' })
  const label2 = await s.page.locator('.range-value').innerText()
  check('preset rolls one UTC day after the clock moves', /Last 30 days · Oct 27 – Nov 25/.test(label2), label2)

  // A custom range never moves, even days later.
  await s.page.locator('.range-picker > summary').click()
  // Let the toggle handler seed the drafts before filling them.
  await s.page.waitForTimeout(300)
  await s.page.getByLabel('Start date').fill('2026-11-01')
  await s.page.getByLabel('End date').fill('2026-11-20')
  await s.page.getByRole('button', { name: 'Apply dates' }).click()
  await s.page.clock.setFixedTime(new Date(CLOCK_BASE + 3 * 86400_000))
  await s.page.reload({ waitUntil: 'load' })
  const label3 = await s.page.locator('.range-value').innerText()
  check('custom range stays fixed across reloads', /Custom · Nov 1 – Nov 20/.test(label3), label3)
  check('shortcut released for a custom range', (await s.page.getByRole('button', { name: 'Last 30 days', exact: true }).getAttribute('aria-pressed')) === 'false')
  await s.context.close()
}

// 5. Pill and account-panel removal; the user menu signs out.
async function stepRemoval(browser, width, height) {
  const s = await newPage(browser, { width, height, owner: OWNER1, email: EMAIL1 })
  await s.page.goto(`${origin}/`)
  await s.page.getByLabel('Select website').waitFor({ timeout: 30000 })
  for (const path of ['/', '/websites/', '/connections/']) {
    await s.page.goto(`${origin}${path}`, { waitUntil: 'load' })
    await s.page.getByLabel('Select website').waitFor({ timeout: 30000 })
    check(`no Google services pill in header (${width} ${path})`, await s.page.locator('header').getByText('Google services').count() === 0)
    check(`no Your account heading anywhere (${width} ${path})`, await s.page.getByRole('heading', { name: 'Your account' }).count() === 0)
  }
  const menuButton = s.page.getByRole('button', { name: `Account menu for ${EMAIL1}` })
  check(`user menu button visible (${width})`, await menuButton.isVisible())
  await menuButton.click()
  const signOut = s.page.getByRole('menuitem', { name: 'Sign out' })
  await signOut.waitFor({ timeout: 15000 })
  await signOut.click()
  // The layout's expiry watch may attach the page they left as the redirect.
  const signedOut = redirectPath(s.page, '/sign-in', 30000)
  check(`sign out returns to sign-in (${width})`, (await signedOut).pathname === '/sign-in', s.page.url())
  await s.context.close()
}

// 6. Forms nav gating (default artifact: absent).
async function stepFormsNav(browser, width, height) {
  const s = await newPage(browser, { width, height, owner: OWNER1, email: EMAIL1 })
  await s.page.goto(`${origin}/`)
  await s.page.getByLabel('Select website').waitFor({ timeout: 30000 })
  const links = await s.page.getByRole('link', { name: 'Forms', exact: true }).count()
  if (expectForms) check(`Forms nav link present (${width})`, links === 1)
  else check(`Forms nav link absent by default (${width})`, links === 0)
  await s.context.close()
}

// 7. One site selector; developer pages have no account panel.
async function stepSelectors(browser) {
  const s = await newPage(browser, { width: 1280, height: 800, owner: OWNER1, email: EMAIL1 })
  await s.page.goto(`${origin}/independent-audits/`)
  await s.page.getByText('Independent audit comparisons are not available yet.').waitFor({ timeout: 30000 })
  check('single labelled website select on independent-audits', await s.page.getByLabel('Select website').count() === 1)
  check('no site select left inside the page shell', await s.page.locator('main.page-shell select').count() === 0)
  for (const path of ['/developer/', '/mcp/']) {
    await s.page.goto(`${origin}${path}`, { waitUntil: 'load' })
    check(`developer page without account panel (${path})`, await s.page.getByText('Your account').count() === 0)
  }
  await s.context.close()
}

// 8. Range math stays UTC while the browser is in EST.
async function stepZone(browser, width, height) {
  const s = await newPage(browser, { width, height, owner: OWNER1, email: EMAIL1, clock: new Date(CLOCK_BASE) })
  await s.page.goto(`${origin}/`)
  const value = s.page.locator('.range-value')
  await value.waitFor({ timeout: 30000 })
  await s.page.waitForFunction(() => document.querySelector('.range-value')?.textContent?.includes('Oct 26'), undefined, { timeout: 30000 })
  const label = await value.innerText()
  check(`UTC range window in a non-UTC browser zone (${width})`, /Last 30 days · Oct 26 – Nov 24/.test(label), label)
  await s.context.close()
}

const browser = await chromium.launch({ headless: true })
try {
  await stepSignIn(browser, 1280, 800)
  await stepPublic(browser)
  await stepSelection(browser)
  await stepRange(browser)
  await stepRemoval(browser, 1280, 800)
  await stepFormsNav(browser, 1280, 800)
  await stepSelectors(browser)
  await stepZone(browser, 1280, 800)
  // Narrow pass: the checks that change with layout.
  await stepSignIn(browser, 390, 844)
  await stepRemoval(browser, 390, 844)
  await stepFormsNav(browser, 390, 844)
  await stepZone(browser, 390, 844)
} finally {
  await browser.close()
}

check('no page errors on any surface', pageErrors.length === 0, pageErrors.join(' | '))
check('no unexpected external hosts', foreignHosts.length === 0, foreignHosts.slice(0, 5).join(' | '))

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nshell fixture: all checks passed')
