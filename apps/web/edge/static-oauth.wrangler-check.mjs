// Run with: node edge/static-oauth.wrangler-check.mjs /path/to/wrangler/bin/wrangler.js
// Uses a temporary HOME/cwd/config: never reads workspace .env/.dev.vars or CLI credentials.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { setTimeout as pause } from 'node:timers/promises'
import { createServer } from 'node:net'
const cli = resolve(process.argv[2])
const root = await mkdtemp(join(tmpdir(), 'htp-oauth-wrangler-'))
let child
try {
  const config = JSON.parse((await readFile(new URL('../wrangler.oauth-candidate.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, ''))
  assert.deepEqual(config.assets.run_worker_first, ['/api/google/connect', '/auth/google/callback', '/api/bing/connect', '/auth/bing/callback'])
  assert.equal(config.observability.enabled, false)
  assert.equal(config.routes, undefined)
  await mkdir(join(root, 'public'), { recursive: true })
  await writeFile(join(root, 'public/index.html'), 'synthetic SPA')
  for (const path of config.assets.run_worker_first) {
    await mkdir(join(root, 'public', path.slice(1)), { recursive: true })
    await writeFile(join(root, 'public', path.slice(1), 'index.html'), 'must not serve OAuth collision')
  }
  // Same candidate handler/config; only temporary entry/asset locations differ.
  config.main = './worker.mjs'
  config.assets.directory = './public'
  delete config.$schema
  await writeFile(join(root, 'worker.mjs'), await readFile(new URL('./static-oauth.mjs', import.meta.url)))
  await writeFile(join(root, 'wrangler.json'), JSON.stringify(config))
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  child = spawn(process.execPath, [cli, 'dev', '--local', '--config', join(root, 'wrangler.json'), '--ip', '127.0.0.1', '--port', String(port), '--log-level', 'none'], {
    cwd: root, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, WRANGLER_SEND_METRICS: 'false', CI: 'true', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
  })
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break } } catch {}
    if (child.exitCode !== null) throw Error('Local Wrangler exited')
    await pause(200)
  }
  assert.ok(ready, 'local Wrangler ready')
  let checks = 0
  for (const path of config.assets.run_worker_first) {
    // Foreign local origin fails before any external transport, even on collision.
    const response = await fetch(base + path, { redirect: 'manual' })
    assert.equal(response.status, 403)
    assert.match(response.headers.get('cache-control'), /no-store/)
    assert.equal(await response.text(), 'OAuth request unavailable.')
    checks++
  }
  for (const path of ['/', '/dashboard', '/api/unrelated', '/auth/google/callback-near']) {
    const response = await fetch(base + path)
    assert.equal(await response.text(), 'synthetic SPA')
    checks++
  }
  console.log(`Local Wrangler: ${checks} routing checks passed (four exact asset collisions; four asset/SPA paths).`)
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }
  await rm(root, { recursive: true, force: true })
}
