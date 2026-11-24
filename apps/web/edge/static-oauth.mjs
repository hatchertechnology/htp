// Compatibility transport only. Nitro owns identity, sealed state, PKCE and grants.
const ORIGIN = 'https://htp.hatchtech.dev'
const BACKEND = 'https://htp-web-kerry-hatcher.fly.dev'
const actions = new Map(['google', 'bing'].flatMap(provider => [
  [`/api/${provider}/connect`, { provider, method: 'POST', connect: true }],
  [`/auth/${provider}/callback`, { provider, method: 'GET', connect: false }],
]))
function headers() {
  return new Headers({ 'Cache-Control': 'no-store, private', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
}
function failure(status) { return new Response('OAuth request unavailable.', { status, headers: headers() }) }
function safeLocation(value, provider) {
  const results = provider === 'google' ? ['invalid_state', 'denied', 'missing_scope', 'failed'] : ['invalid_state', 'denied', 'failed', 'connected']
  const allowed = results.map(result => `/connections?${provider}=${result}`)
  if (provider === 'google') allowed.push('/?google=connected')
  return allowed.includes(value)
}
// Injection is for local synthetic tests; the deployed handler always uses fetch.
export async function handle(request, env, transport = fetch) {
  const url = new URL(request.url)
  const action = actions.get(url.pathname)
  if (!action) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return failure(404)
    if (!['GET', 'HEAD'].includes(request.method)) return failure(405)
    // Never pass browser credentials, referrer or URL query into asset subrequests.
    return env.ASSETS.fetch(new Request(`${ORIGIN}${url.pathname}`, { method: request.method }))
  }
  if (url.origin !== ORIGIN) return failure(403)
  if (request.method !== action.method) return failure(405)
  const outgoing = new Headers()
  if (action.connect) {
    const origin = request.headers.get('origin')
    if (origin && origin !== ORIGIN) return failure(403)
    const bearer = request.headers.get('authorization')
    if (!bearer || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/i.test(bearer)) return failure(401)
    outgoing.set('authorization', bearer)
    if (origin) outgoing.set('origin', origin)
  } else {
    const name = `htp_${action.provider}_state`
    const cookies = (request.headers.get('cookie') || '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${name}=`))
    // Missing state still reaches Nitro, which clears it and returns invalid_state.
    if (cookies.length === 1) outgoing.set('cookie', cookies[0])
  }
  const target = new URL(url.pathname, BACKEND)
  if (!action.connect) {
    // Nitro consumes only these fields; preserve duplicates for its validation.
    for (const [key, value] of url.searchParams) if (['code', 'state', 'error'].includes(key)) target.searchParams.append(key, value)
  }
  try {
    const upstream = await transport(new Request(target, { method: action.method, headers: outgoing, redirect: 'manual', signal: AbortSignal.timeout(30_000) }))
    const result = headers()
    const location = upstream.headers.get('location')
    if (location && (action.connect || !safeLocation(location, action.provider))) { await upstream.body?.cancel(); return failure(502) }
    if (!action.connect && (!location || upstream.status !== 302)) { await upstream.body?.cancel(); return failure(502) }
    if (location) result.set('location', location)
    for (const cookie of upstream.headers.getSetCookie()) {
      // Keep Nitro's cookie attributes verbatim; no backend Domain rewriting.
      const name = cookie.slice(0, cookie.indexOf('='))
      if (name === `htp_${action.provider}_state` || (!action.connect && action.provider === 'google' && name === 'htp_google' && /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(cookie))) result.append('set-cookie', cookie)
    }
    if (!action.connect) {
      await upstream.body?.cancel()
      return new Response(null, { status: 302, headers: result })
    }
    result.set('content-type', 'application/json')
    return new Response(upstream.body, { status: upstream.status, headers: result })
  } catch { return failure(502) } // Never log request URLs, credentials or exceptions.
}
export default { fetch: (request, env) => handle(request, env) }
