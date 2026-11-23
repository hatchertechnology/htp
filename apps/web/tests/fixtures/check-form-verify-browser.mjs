import { chromium } from 'playwright'
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const server = await createServer({ configFile: false, root: process.cwd(), optimizeDeps: { noDiscovery: true, include: ['@supabase/supabase-js'] }, server: { host: '127.0.0.1', port: 42580, strictPort: true } })
const deno = spawn(process.env.DENO_BIN || 'deno', ['run', '--allow-net=127.0.0.1:42581', '../../supabase/functions/form-verify/browser_fixture.ts'], { stdio: ['ignore', 'pipe', 'pipe'] })
let browser, methods = ''
let startupError
deno.on('error', error => { startupError = error })
deno.stdout.on('data', chunk => { methods += chunk.toString() })
try {
  await server.listen()
  await new Promise((resolve, reject) => {
    deno.stderr.on('data', chunk => { if (chunk.toString().includes('Listening on')) resolve() })
    deno.on('exit', code => reject(new Error(`fixture exited: ${code}`)))
    if (startupError) reject(startupError)
    else deno.once('error', reject)
  })
  browser = await chromium.launch({ args: ['--no-proxy-server'] })
  const page = await browser.newPage()
  const requests = []
  page.on('request', req => { if (req.url().includes('42581/functions/')) requests.push({ method: req.method(), headers: req.headers() }) })
  await page.goto('http://127.0.0.1:42580/tests/fixtures/form-verify-browser.html')
  await page.waitForFunction(() => window.verify)
  assert.deepEqual(await page.evaluate(() => window.verify('a'.repeat(64))), { data: { ok: true } })
  assert.deepEqual(await page.evaluate(() => window.verify('b'.repeat(64))), { name: 'FunctionsHttpError', status: 422, body: { error: 'verification_failed' } })
  assert(methods.includes('OPTIONS'), 'handler did not receive preflight')
  const post = requests.find(req => req.method === 'POST')
  for (const header of ['authorization', 'apikey', 'x-client-info', 'content-type']) assert(post.headers[header], `missing ${header}`)
  await page.goto('http://localhost:42580/tests/fixtures/form-verify-browser.html')
  await page.waitForFunction(() => window.verify)
  assert.equal((await page.evaluate(() => window.verify('a'.repeat(64)))).name, 'FunctionsFetchError')
  console.log('PASS: SDK browser preflight, authenticated POST success and readable 422 error')
} finally {
  await browser?.close()
  await server.close()
  deno.kill()
}
