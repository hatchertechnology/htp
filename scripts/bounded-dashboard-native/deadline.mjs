import http from 'node:http'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const id = '00000000-0000-4000-8000-000000000001',
  run = '00000000-0000-4000-8000-000000000002'
let closed = false
const mock = http.createServer((req, res) => {
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
    PORT: '38294',
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
      await fetch('http://127.0.0.1:38294/')
      break
    } catch {
      if (i > 100) throw Error('startup')
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const url =
    `http://127.0.0.1:38294/api/websites/${id}/seo/audits/${run}/dashboard`
  const unauthorized = await fetch(url)
  assert.equal(unauthorized.status, 401)
  assert.match(unauthorized.headers.get('cache-control'), /no-store/)
  console.log('early 401 no-store passed')
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
} finally {
  child.kill()
  mock.closeAllConnections()
  await new Promise((r) => mock.close(r))
}
