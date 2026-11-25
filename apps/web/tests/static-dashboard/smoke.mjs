// Static deep-link smoke test for the opt-in static dashboard artifact.
// Serves .output/public through a local `wrangler dev` (workerd, no deploy,
// no account, no route) and checks SPA deep links, assets and headers.
// Run `npm run build:static` first.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = join(root, '.output', 'public')
const port = 8788
const base = `http://127.0.0.1:${port}`
const failures = []

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

if (!existsSync(join(out, 'index.html'))) {
  console.error('missing .output/public/index.html; run npm run build:static first')
  process.exit(2)
}
check('no Nitro server in artifact', !existsSync(join(root, '.output', 'server')))

const wrangler = spawn(
  'npx',
  ['--yes', 'wrangler@4.168.0', 'dev', '--config', 'wrangler.jsonc', '--ip', '127.0.0.1', '--port', String(port)],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' } },
)
let log = ''
wrangler.stdout.on('data', (d) => { log += d })
wrangler.stderr.on('data', (d) => { log += d })

async function waitReady(timeoutMs = 90000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/`)
      if (res.status === 200) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`wrangler dev not ready\n${log.slice(-2000)}`)
}

async function get(path, init = {}) {
  return fetch(`${base}${path}`, { redirect: 'manual', ...init })
}

try {
  await waitReady()

  // Deep links must return the SPA shell (200 HTML), not a 404.
  const deepLinks = [
    '/', '/websites', '/connections', '/guide', '/mcp', '/developer',
    '/independent-audits', '/forms/confirm?token=synthetic',
    '/oauth/consent?authorization_id=synthetic', '/sign-in?redirect=%2F',
    '/forms',
  ]
  for (const path of deepLinks) {
    // Follow Cloudflare's html_handling redirect (e.g. /websites -> /websites/).
    const res = await get(path, { redirect: 'follow' })
    const html = await res.text()
    check(`deep link ${path}`, res.status === 200 && /text\/html/.test(res.headers.get('content-type') || '') && html.includes('__nuxt'), `status ${res.status} final ${new URL(res.url).pathname}`)
  }

  // Auth callbacks are Nitro server routes in the Fly build. The static artifact
  // only serves the SPA shell here; the real exchange is an integration gate.
  const cb = await get('/auth/google/callback?code=synthetic&state=synthetic')
  check('auth callback path serves SPA shell (exchange is an integration gate)', cb.status === 200, `status ${cb.status}`)

  // Asset delivery: the entry JS referenced by the shell must be served.
  const shell = await (await get('/')).text()
  const match = shell.match(/\/_nuxt\/[^"'\s<>]+\.js/)
  check('shell references a _nuxt JS asset', Boolean(match))
  if (match) {
    const asset = await get(match[0])
    check('_nuxt asset served as JavaScript', asset.status === 200 && /javascript/.test(asset.headers.get('content-type') || ''), `status ${asset.status}`)
  }
  const fav = await get('/favicon.svg')
  check('favicon.svg served', fav.status === 200 && /svg/.test(fav.headers.get('content-type') || ''), `status ${fav.status}`)

  // Known limitation: single-page-application fallback answers a missing hashed
  // asset with the HTML shell (200). Stale clients after a redeploy hit this
  // path; it is recorded, not hidden. Tracked in the task note.
  const missing = await get('/_nuxt/does-not-exist.js')
  const missingType = missing.headers.get('content-type') || ''
  console.log(`INFO missing _nuxt asset -> status ${missing.status} ${missingType} (known SPA-fallback limitation)`)

  // Headers from scripts/static-dashboard/_headers.
  const consent = await get('/oauth/consent?authorization_id=synthetic')
  check('/oauth/* no-store', /no-store/.test(consent.headers.get('cache-control') || ''))
  check('/oauth/* noindex', /noindex/.test(consent.headers.get('x-robots-tag') || ''))
  const signIn = await get('/sign-in', { redirect: 'follow' })
  check('/sign-in no-store', /no-store/.test(signIn.headers.get('cache-control') || ''))
  check('/sign-in no-referrer', /no-referrer/.test(signIn.headers.get('referrer-policy') || ''))
  check('frame denial on app routes', /DENY/i.test((await get('/websites/', { redirect: 'follow' })).headers.get('x-frame-options') || ''))

  // Read-only static hosting.
  const post = await get('/', { method: 'POST' })
  check('POST rejected', post.status === 405, `status ${post.status}`)
} catch (error) {
  check('smoke run completed', false, String(error.message || error).slice(0, 500))
} finally {
  wrangler.kill('SIGTERM')
}

const expected = readFileSync(join(out, '_headers'), 'utf8').includes('/oauth/*')
check('_headers copied into artifact', expected)

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nstatic smoke: all checks passed')
