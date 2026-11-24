// Opt-in static dashboard build for Cloudflare Workers Static Assets.
// Produces .output/public with no Nitro server. The default Fly build is
// unaffected: it does not run this script and keeps SSR enabled.
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = {
  ...process.env,
  HTP_WEB_BUILD_TARGET: 'static',
  NUXT_PUBLIC_STATIC_DASHBOARD: 'true',
  NUXT_TELEMETRY_DISABLED: '1',
}

rmSync(join(root, '.output'), { recursive: true, force: true })
const result = spawnSync(join(root, 'node_modules', '.bin', 'nuxt'), ['generate'], {
  cwd: root,
  env,
  stdio: 'inherit',
})
if (result.status !== 0) process.exit(result.status ?? 1)

const out = join(root, '.output', 'public')
if (!existsSync(join(out, 'index.html'))) {
  console.error('static build: .output/public/index.html missing')
  process.exit(1)
}
if (existsSync(join(root, '.output', 'server'))) {
  console.error('static build: unexpected .output/server (Nitro runtime present)')
  process.exit(1)
}
copyFileSync(join(root, 'scripts', 'static-dashboard', '_headers'), join(out, '_headers'))
console.log(`static build ready: ${out}`)
