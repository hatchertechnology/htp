// Browser talks to the real Rust API via a disposable loopback TLS proxy.
// The parent Rust test supplies a synthetic API and mock RPC server.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { request } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const port = Number(process.env.FORMS_BROWSER_API_PORT)
if (!Number.isInteger(port) || port < 1) throw new Error('Disposable API port required')
const dir = await mkdtemp(join(tmpdir(), 'forms-api-browser-'))
let server, browser
try {
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=fixture.test'], { stdio: 'ignore' })
  server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    const host = req.headers.host?.split(':')[0]
    if (host !== 'api.test') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Fixture</title>'); return }
    const target = new URL(req.url, 'https://api.test')
    const headers = { ...req.headers, host: '127.0.0.1', 'fly-client-ip': target.searchParams.has('early') ? '192.0.2.2' : '192.0.2.1' }
    const upstream = request({ hostname: '127.0.0.1', port, path: target.pathname, method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(upstream)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(56575, '127.0.0.1', resolve) })
  browser = await chromium.launch({ args: ['--no-proxy-server', '--host-resolver-rules=MAP visitor.test 127.0.0.1:56575, MAP foreign.test 127.0.0.1:56575, MAP api.test 127.0.0.1:56575'] })
  const page = await browser.newPage({ ignoreHTTPSErrors: true })
  await page.goto('https://visitor.test/')
  const call = async (form, query = '') => page.evaluate(async ({ form, query }) => {
    try {
      const response = await fetch(`https://api.test/public/forms/${form}${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ submission_id: '00000000-0000-0000-0000-000000000005', name: 'Ada', email: 'ada@example.com' }) })
      return { status: response.status, retry: response.headers.get('retry-after'), body: await response.json() }
    } catch { return { error: 'opaque' } }
  }, { form, query })
  const limited = '00000000-0000-0000-0000-000000000003'
  const normal = '00000000-0000-0000-0000-000000000004'
  assert.deepEqual(await call(limited), { status: 429, retry: '600', body: { error: 'rate_limited' } })
  assert.deepEqual(await call(normal, '?early=1'), { error: 'opaque' })
  assert.deepEqual(await call(normal), { status: 200, retry: null, body: { ok: true, duplicate: false } })
  assert.deepEqual(await call(normal), { status: 200, retry: null, body: { ok: true, duplicate: true } })
  await page.goto('https://foreign.test/')
  assert.deepEqual(await call(normal), { error: 'opaque' })
  console.log('PASS: actual API browser preflight, readable limit, opaque early failure/retry and foreign-origin denial')
} finally {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
}
