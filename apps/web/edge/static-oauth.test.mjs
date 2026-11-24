import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle } from './static-oauth.mjs'
const origin = 'https://htp.hatchtech.dev'
const env = { ASSETS: { fetch: async r => { assert.equal(new URL(r.url).search, ''); assert.equal([...r.headers].length, 0); return new Response('asset') } } }
const never = () => { throw Error('Unexpected transport') }
for (const provider of ['google', 'bing']) {
  test(`${provider}: connect forwards only owner bearer and accepted origin`, async () => {
    const r = await handle(new Request(`${origin}/api/${provider}/connect?target=https://evil.test`, { method: 'POST', body: 'ignored', headers: { authorization: 'Bearer synthetic', origin, cookie: 'secret=ignored', 'x-forwarded-host': 'evil.test', 'content-type': 'text/plain' } }), env, async request => {
      assert.equal(request.url, `https://htp-web-kerry-hatcher.fly.dev/api/${provider}/connect`)
      assert.equal(request.redirect, 'manual')
      assert.deepEqual([...request.headers], [['authorization', 'Bearer synthetic'], ['origin', origin]])
      assert.equal(await request.text(), '')
      return new Response('{"url":"https://provider.test/authorize"}', { headers: { 'set-cookie': `htp_${provider}_state=sealed; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`, 'cache-control': 'public', 'x-secret': 'drop' } })
    })
    assert.match(r.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax; Max-Age=600/)
    assert.equal(r.headers.get('x-secret'), null)
    assert.match(r.headers.get('cache-control'), /no-store/)
  })
  test(`${provider}: callback retains only state cookie and consumed query, strips body`, async () => {
    const r = await handle(new Request(`${origin}/auth/${provider}/callback?code=synthetic&state=synthetic&extra=drop`, { headers: { cookie: `other=secret; htp_${provider}_state=sealed; htp_google=legacy`, authorization: 'Bearer drop', referer: 'https://provider.test' } }), env, async request => {
      assert.equal(request.url, `https://htp-web-kerry-hatcher.fly.dev/auth/${provider}/callback?code=synthetic&state=synthetic`)
      assert.deepEqual([...request.headers], [['cookie', `htp_${provider}_state=sealed`]])
      const h = new Headers({ location: provider === 'google' ? '/?google=connected' : '/connections?bing=connected' })
      h.append('set-cookie', `htp_${provider}_state=; Max-Age=0; Path=/`)
      h.append('set-cookie', 'unrelated=drop')
      if (provider === 'google') h.append('set-cookie', 'htp_google=; Max-Age=0; Path=/')
      return new Response('code must not reach browser body', { status: 302, headers: h })
    })
    assert.equal(r.status, 302)
    assert.equal(await r.text(), '')
    assert.equal(r.headers.getSetCookie().length, provider === 'google' ? 2 : 1)
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
  })
  test(`${provider}: rejects methods, foreign origins and invalid bearer locally`, async () => {
    for (const [path, init, status] of [
      [`/api/${provider}/connect`, {}, 405],
      [`/api/${provider}/connect`, { method: 'POST' }, 401],
      [`/api/${provider}/connect`, { method: 'POST', headers: { origin: 'https://evil.test', authorization: 'Bearer synthetic' } }, 403],
      [`/auth/${provider}/callback`, { method: 'POST' }, 405],
    ]) assert.equal((await handle(new Request(origin + path, init), env, never)).status, status)
    assert.equal((await handle(new Request(`https://evil.test/auth/${provider}/callback`), env, never)).status, 403)
  })
  test(`${provider}: callback missing/duplicate cookie and safe redirect failures`, async () => {
    for (const cookie of ['', `htp_${provider}_state=a; htp_${provider}_state=b`]) {
      const r = await handle(new Request(`${origin}/auth/${provider}/callback`, { headers: { cookie } }), env, async request => {
        assert.equal(request.headers.get('cookie'), null)
        return new Response(null, { status: 302, headers: { location: `/connections?${provider}=invalid_state` } })
      })
      assert.equal(r.status, 302)
    }
    for (const location of ['https://evil.test', '//evil.test', '/connections?code=secret', 'https://htp.hatchtech.dev/connections']) {
      assert.equal((await handle(new Request(`${origin}/auth/${provider}/callback`), env, async () => new Response(null, { status: 302, headers: { location } }))).status, 502)
    }
    assert.equal((await handle(new Request(`${origin}/auth/${provider}/callback`), env, never)).status, 502)
  })
}
test('no arbitrary proxy or credential-bearing asset requests', async () => {
  for (const path of ['/api/google/connect/', '/api/bing/connection', '/api/anything', '/auth/google/callback/']) assert.equal((await handle(new Request(origin + path), env, never)).status, 404)
  assert.equal(await (await handle(new Request(`${origin}/dashboard?code=drop&token=drop`, { headers: { cookie: 'drop', authorization: 'Bearer drop', referer: `${origin}/?code=drop` } }), env, never)).text(), 'asset')
})
test('exact Nitro redirects and connect error status remain non-cacheable', async () => {
  for (const provider of ['google', 'bing']) {
    const results = provider === 'google' ? ['invalid_state', 'denied', 'missing_scope', 'failed'] : ['invalid_state', 'denied', 'failed', 'connected']
    for (const result of results) {
      const location = `/connections?${provider}=${result}`
      const r = await handle(new Request(`${origin}/auth/${provider}/callback`), env, async () => new Response(null, { status: 302, headers: { location } }))
      assert.equal(r.headers.get('location'), location)
      assert.match(r.headers.get('cache-control'), /no-store/)
    }
    const r = await handle(new Request(`${origin}/api/${provider}/connect`, { method: 'POST', headers: { authorization: 'Bearer synthetic' } }), env, async request => {
      assert.deepEqual([...request.headers], [['authorization', 'Bearer synthetic']])
      return new Response('{"message":"synthetic unavailable"}', { status: 503, headers: { 'cache-control': 'public' } })
    })
    assert.equal(r.status, 503)
    assert.match(r.headers.get('cache-control'), /no-store/)
  }
})
