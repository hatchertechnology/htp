import http from 'node:http'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const id = '00000000-0000-4000-8000-000000000001',
  run = '00000000-0000-4000-8000-000000000002'
const webPort = process.env.H15_DEADLINE_PORT || '38294'
let closed = false, authClosed = 0, authStarted = 0
const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/auth/') && req.headers.authorization === 'Bearer invalid') {
    res.writeHead(401, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ message: 'Invalid token' }))
  }
  if (req.url.startsWith('/auth/') && req.headers.authorization === 'Bearer hanging') {
    authStarted++
    res.on('close', () => authClosed++)
    return
  }
  if (req.url.startsWith('/auth/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({ id, aud: 'authenticated', role: 'authenticated' }),
    )
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.write('{"incomplete":')
  res.on('close', () => closed = true)
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const child = spawn(process.execPath, ['.output/server/index.mjs'], {
  cwd: process.argv[2],
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: webPort,
    NUXT_PUBLIC_BOUNDED_SAVED_DETAIL: 'true',
    NUXT_API_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
    NUXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${mock.address().port}`,
    NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic',
  },
  stdio: 'ignore',
})
try {
  for (let i = 0;; i++) {
    try {
      await fetch(`http://127.0.0.1:${webPort}/`)
      break
    } catch {
      if (i > 100) throw Error('startup')
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const url =
    `http://127.0.0.1:${webPort}/api/websites/${id}/seo/audits/${run}/dashboard`
  const unauthorized = await fetch(url)
  assert.equal(unauthorized.status, 401)
  assert.match(unauthorized.headers.get('cache-control'), /no-store/)
  const invalid = await fetch(url, {
    headers: { authorization: 'Bearer invalid' },
  })
  assert.equal(invalid.status, 401)
  assert.match(invalid.headers.get('cache-control'), /no-store/)
  console.log('missing and rejected credentials return 401 no-store')
  const cancelled = new AbortController()
  const pending = fetch(url, {
    headers: { authorization: 'Bearer hanging' },
    signal: cancelled.signal,
  }).catch(() => {})
  for (let i = 0; authStarted < 1 && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.equal(authStarted, 1)
  cancelled.abort()
  await pending
  for (let i = 0; authClosed < 1 && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.equal(authClosed, 1, 'disconnect must close hanging auth upstream')
  const authStart = Date.now()
  const authTimeout = fetch(url, {
    headers: { authorization: 'Bearer hanging' },
  })
  const start = Date.now(),
    r = await fetch(url, { headers: { authorization: 'Bearer synthetic' } })
  assert.equal(r.status, 200)
  let rejected = false
  try {
    await r.json()
  } catch {
    rejected = true
  }
  const elapsed = Date.now() - start
  console.log('stalled body', JSON.stringify({ rejected, elapsed, closed }))
  assert.ok(rejected && closed && elapsed >= 119000 && elapsed < 130000)
  const authResponse = await authTimeout
  assert.equal(authResponse.status, 504)
  assert.match(authResponse.headers.get('cache-control'), /no-store/)
  assert.ok(Date.now() - authStart >= 119000 && authClosed >= 2)
  console.log('hanging auth timeout and upstream closure passed')
} finally {
  child.kill()
  mock.closeAllConnections()
  await new Promise((r) => mock.close(r))
}
