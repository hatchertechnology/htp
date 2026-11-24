// Full-mode normal-path fixture: real PostgREST RPCs, signed owner/nonowner, disposable loopback only.
import { createHmac, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { chromium } from '../../apps/web/node_modules/playwright/index.mjs'
const base = process.env.FIXTURE_REST
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('loopback only')
const secret = 'fixture-only-secret-at-least-thirty-two-bytes'
const site = '00000000-0000-0000-0000-000000000003', src = '00000000-0000-0000-0000-000000000006', cmp = '00000000-0000-0000-0000-000000000007', delivery = '00000000-0000-0000-0000-000000000004'
const jwt = id => { const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url'); const h = enc({ alg: 'HS256', typ: 'JWT' }), p = enc({ sub: id, role: 'authenticated', aud: 'authenticated', is_anonymous: false, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}` }
const owner = jwt('00000000-0000-0000-0000-000000000001'), other = jwt('00000000-0000-0000-0000-000000000002')
const rpc = async (token, name, body) => { const r = await fetch(`${base}/rpc/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const text = await r.text(); return { status: r.status, text, json: JSON.parse(text || 'null'), bytes: Buffer.byteLength(text) } }

const csv = await readFile('apps/web/tests/fixtures/independent-tool-controlled.csv')
const csvText = csv.toString('utf8'), csvSha = createHash('sha256').update(csv).digest('hex')
const imported = await rpc(owner, 'import_independent_audit', { p_website_id: site, p_format: 'controlled-csv-v1', p_source: csvText, p_metadata: { filename: 'independent-tool-controlled.csv', provenance: { tool: 'locally generated standalone crawler', version: '9.4' } } })
if (imported.status !== 200 || imported.json.source_sha256 !== csvSha) throw Error(`owner import failed: ${imported.status} ${imported.text}`)
const detail = await rpc(owner, 'independent_audit_history', { p_website_id: site, p_id: imported.json.id })
if (detail.status !== 200 || detail.json.source_text !== csvText || detail.json.source_sha256 !== csvSha) throw Error('imported source bytes or digest changed')
if (detail.json.metadata?.provenance?.tool !== 'locally generated standalone crawler') throw Error('provenance not preserved')
for (const [name, body] of [
  ['import_independent_audit', { p_website_id: site, p_format: 'controlled-csv-v1', p_source: csvText, p_metadata: {} }],
  ['independent_audit_history', { p_website_id: site }],
  ['save_independent_comparison', { p_website_id: site, p_import_id: src, p_delivery_id: delivery, p_asserted: true }],
]) { const denied = await rpc(other, name, body); if (denied.status !== 403) throw Error(`nonowner ${name} not denied: ${denied.status} ${denied.text}`) }
const saved = await rpc(owner, 'save_independent_comparison', { p_website_id: site, p_import_id: src, p_delivery_id: delivery, p_asserted: true })
if (saved.status !== 200) throw Error(`owner save failed: ${saved.status} ${saved.text}`)
const replay = await rpc(owner, 'independent_comparison_detail', { p_website_id: site, p_comparison_id: cmp })
if (replay.status !== 200 || replay.json.source.source_text !== csvText || replay.json.seosmith.report.engine_version !== '0.2.0') throw Error('seeded comparison replay lost pinned evidence')
console.log(`native report detail: import ${detail.bytes} bytes; comparison detail ${replay.bytes} bytes; source ${csv.byteLength} bytes sha ${csvSha}`)

const browser = await chromium.launch({ headless: true })
try {
  const browserChecks = async (label, token, id) => {
    const page = await browser.newPage(), calls = [], errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(({ token, id }) => localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'fixture', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id, aud: 'authenticated', role: 'authenticated' } })), { token, id })
    await page.route('**/*', async route => {
      const u = new URL(route.request().url()), path = u.pathname
      if (u.origin === base && path.startsWith('/rest/v1/')) {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,OPTIONS' } })
        calls.push(path.split('/').pop())
        const response = await route.fetch({ url: base + path.replace('/rest/v1', '') + u.search })
        return route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } })
      }
      if (path.startsWith('/api/google/') || path.startsWith('/api/bing/')) return route.fulfill({ json: { connected: false, configured: false } })
      if (path === '/api/websites') return route.fulfill({ json: { items: [{ id: site, fqdn: 'independent.example' }], has_more: false } })
      if (path === `/api/websites/${site}/seo/audits`) return route.fulfill({ json: { items: [{ delivery_id: delivery, scan_at: '2026-11-20T09:00:00Z', summary: { outcome: 'completed' } }], next_cursor: null } })
      if (path === `/api/websites/${site}/seo/audits/${delivery}`) return route.fulfill({ json: { report: JSON.parse(await readFile('apps/web/tests/fixtures/independent-tool-report.json', 'utf8')), fqdn: 'independent.example', sha256: createHash('sha256').update(await readFile('apps/web/tests/fixtures/independent-tool-report.json')).digest('hex') } })
      if (u.hostname !== '127.0.0.1') return route.abort()
      return route.continue()
    })
    await page.goto('http://127.0.0.1:31991/independent-audits')
    if (label === 'owner') {
      await page.getByRole('button', { name: /independent-tool-controlled.csv/ }).first().waitFor()
      await page.getByRole('button', { name: /independent-tool-controlled.csv/ }).first().click()
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Download original CSV' }).click()
      const got = await readFile(await (await download).path())
      if (!got.equals(csv)) throw Error('downloaded original CSV is not byte-identical')
      await page.getByText('locally generated standalone crawler').waitFor()
      await page.getByRole('button', { name: /s15-metadata-1/ }).first().click()
      await page.getByRole('table').waitFor()
      await page.getByText(/2 agreement/).waitFor()
      for (const category of ['independent_only', 'seosmith_only', 'unknown', 'unmapped']) if (!await page.getByRole('table').getByText(category, { exact: true }).count()) throw Error(`comparison table missing ${category}`)
      await page.getByText('Unknown / not provided').first().waitFor()
      await page.getByText(/Compared SEOsmith report/).waitFor()
      await page.getByRole('button', { name: /legacy-controlled.csv/ }).click()
      await page.getByText('Legacy source note').waitFor()
      await page.getByText('Legacy free-text note: parser and rendering differences not assessed.').waitFor()
      if (await page.getByText(/Compared SEOsmith report/).count()) throw Error('legacy import selection retained prior report metadata')
      await page.locator('main.page-shell input[type=file]').setInputFiles({ name: 'independent-tool-controlled.csv', mimeType: 'text/csv', buffer: csv })
      await page.getByLabel('Independent tool').fill('browser imported crawler')
      await page.getByRole('button', { name: 'Save import' }).click()
      await page.getByText('Source saved.').waitFor()
      if (!calls.includes('import_independent_audit')) throw Error('browser import did not reach the native RPC')
    } else {
      await page.getByRole('alert').first().waitFor()
    }
    if (errors.length) throw Error(errors.join(';'))
    const allowed = ['independent_audit_history', 'independent_comparison_history', 'independent_comparison_detail', 'save_independent_comparison', 'import_independent_audit']
    if (calls.some(x => !allowed.includes(x))) throw Error(`unexpected RPC ${calls}`)
    console.log(`${label} browser RPCs: ${calls.join(', ')}`)
    await page.close()
  }
  await browserChecks('owner', owner, '00000000-0000-0000-0000-000000000001')
  await browserChecks('nonowner', other, '00000000-0000-0000-0000-000000000002')
} finally { await browser.close() }
