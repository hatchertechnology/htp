import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import type { H3Event } from 'h3'
import { requireDashboardUser } from './google'
import { seal, unseal } from './sealed-cookie'
const stateCookie = 'htp_bing_state'
type Pending = { user: string; state: string; until: number }
function configuration(event: H3Event) {
  const config = useRuntimeConfig(event)
  if (!config.bingClientId || !config.bingClientSecret || !config.bingCookieKey || !config.supabaseServiceRoleKey) throw createError({ statusCode: 503, message: 'Bing connections are not configured yet.' })
  return { ...config, origin: new URL(config.appOrigin).origin }
}
export function bingStore(event: H3Event) {
  const config = configuration(event)
  return createClient(config.public.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
}
export async function bingConnection(event: H3Event) {
  const user = await requireDashboardUser(event)
  const config = useRuntimeConfig(event)
  const configured = !!config.bingClientId && !!config.bingClientSecret && !!config.bingCookieKey && !!config.supabaseServiceRoleKey
  if (!configured) return { configured, connected: false, reauthorizationRequired: false }
  const { data, error } = await bingStore(event).from('bing_connections').select('status').eq('owner_id', user.id).maybeSingle()
  if (error) throw createError({ statusCode: 503, message: 'Bing connection storage is unavailable.' })
  return { configured, connected: !!data && data.status !== 'disconnected', reauthorizationRequired: data?.status === 'reauthorization_required' }
}
export async function startBing(event: H3Event) {
  const user = await requireDashboardUser(event)
  const config = configuration(event)
  const origin = getHeader(event, 'origin')
  if (origin && origin !== config.origin) throw createError({ statusCode: 403, message: 'Open this dashboard directly to connect Bing.' })
  const state = randomBytes(32).toString('base64url')
  setCookie(event, stateCookie, seal({ user: user.id, state, until: Date.now() + 600_000 } satisfies Pending, config.bingCookieKey, stateCookie), { httpOnly: true, secure: config.origin.startsWith('https:'), sameSite: 'lax', path: '/', maxAge: 600 })
  const url = new URL('https://www.bing.com/webmasters/oauth/authorize')
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.bingClientId, redirect_uri: `${config.origin}/auth/bing/callback`, scope: 'webmaster.read', state }).toString()
  return { url: url.href }
}
export async function finishBing(event: H3Event) {
  const config = configuration(event)
  const pending = unseal<Pending>(getCookie(event, stateCookie), config.bingCookieKey, stateCookie)
  deleteCookie(event, stateCookie, { path: '/' })
  const query = getQuery(event)
  const state = typeof query.state === 'string' ? query.state : ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !pending || pending.until < Date.now() || state.length !== pending.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) return sendRedirect(event, '/connections?bing=invalid_state')
  if (query.error || typeof query.code !== 'string' || query.code.length > 8192) return sendRedirect(event, '/connections?bing=denied')
  let stage = 'token_exchange'
  let tokenStatus = 0
  try {
    const response = await fetch('https://www.bing.com/webmasters/oauth/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ client_id: config.bingClientId, client_secret: config.bingClientSecret, grant_type: 'authorization_code', code: query.code, redirect_uri: `${config.origin}/auth/bing/callback` }),
    })
    tokenStatus = response.status
    const tokens = await response.json()
    if (!response.ok) throw new Error('token_exchange_failed')
    stage = 'refresh_token'
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || tokens.refresh_token.length > 4096) throw new Error('invalid_grant')
    stage = 'read_scope'
    const grantedScopes = (Array.isArray(tokens.scope) ? tokens.scope : typeof tokens.scope === 'string' ? tokens.scope.split(/[\s,]+/) : []).filter((value: unknown): value is string => typeof value === 'string').map((value: string) => value.toLowerCase())
    if (tokens.scope && !grantedScopes.includes('webmaster.read')) throw new Error('missing_scope')
    stage = 'save_connection'
    const { error } = await bingStore(event).from('bing_connections').upsert({
      owner_id: pending.user, generation: randomUUID(), status: 'connected', updated_at: new Date().toISOString(),
      encrypted_grant: seal({ user: pending.user, refresh: tokens.refresh_token, scopes: ['webmaster.read'] }, config.bingCookieKey, `htp_bing_grant:${pending.user}`),
    })
    if (error) throw new Error('storage_unavailable')
    return sendRedirect(event, '/connections?bing=connected')
  } catch {
    // Only fixed stage names and HTTP status are logged, never tokens or provider bodies.
    console.error(`Bing OAuth callback failed (${stage}; HTTP ${tokenStatus}).`)
    return sendRedirect(event, '/connections?bing=failed')
  }
}
export async function disconnectBing(event: H3Event) {
  const user = await requireDashboardUser(event)
  const { error } = await bingStore(event).from('bing_connections').upsert({ owner_id: user.id, generation: randomUUID(), status: 'disconnected', encrypted_grant: '', updated_at: new Date().toISOString() })
  if (error) throw createError({ statusCode: 503, message: 'Could not disconnect Bing. Try again.' })
  deleteCookie(event, stateCookie, { path: '/' })
  return { connected: false }
}
export async function proxyBing(event: H3Event) {
  const user = await requireDashboardUser(event)
  const id = getRouterParam(event, 'id')
  if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw createError({ statusCode: 400, message: 'Choose a valid website.' })
  const result = await $fetch.raw(`${useRuntimeConfig(event).apiBaseUrl.replace(/\/$/, '')}/websites/${id}/bing/dashboard`, {
    method: 'POST', body: {}, headers: { Authorization: user.authorization }, timeout: 15_000, redirect: 'error', retry: 0, ignoreResponseError: true,
  }).catch(() => { throw createError({ statusCode: 502, message: 'Could not load saved Bing data. Try again.' }) })
  setResponseStatus(event, result.status)
  return result._data
}
