import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library'
import { createClient } from '@supabase/supabase-js'
import type { H3Event } from 'h3'
import { seal, unseal } from './sealed-cookie'
import { googleStore } from './google-store'

const scope = 'https://www.googleapis.com/auth/analytics.readonly'
const searchScope = 'https://www.googleapis.com/auth/webmasters.readonly'
const businessScope = 'https://www.googleapis.com/auth/business.manage'
const grantCookie = 'htp_google'
const stateCookie = 'htp_google_state'
type Grant = { user: string; refresh: string; access?: string; expires?: number; until: number; scopes?: string[] }
type Connection = { generation: string; encrypted_grant: string; scopes: string[]; status: string }
type Pending = { user: string; state: string; verifier: string; until: number }

function configuration(event: H3Event) {
  const config = useRuntimeConfig(event)
  if (!config.googleClientId || !config.googleClientSecret || !config.googleCookieKey || !config.supabaseServiceRoleKey) throw createError({ statusCode: 503, message: 'Google connections are not configured yet.' })
  const origin = new URL(config.appOrigin).origin
  return { ...config, origin }
}
function client(event: H3Event) {
  const config = configuration(event)
  return new OAuth2Client(config.googleClientId, config.googleClientSecret, `${config.origin}/auth/google/callback`)
}
function options(event: H3Event, maxAge: number) {
  return { httpOnly: true, secure: configuration(event).origin.startsWith('https:'), sameSite: 'lax' as const, path: '/', maxAge }
}
export async function requireDashboardUser(event: H3Event) {
  const authorization = getHeader(event, 'authorization')
  if (!authorization || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/i.test(authorization)) throw createError({ statusCode: 401, message: 'Sign in to continue.' })
  const config = useRuntimeConfig(event)
  const supabase = createClient(config.public.supabaseUrl, config.public.supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await supabase.auth.getUser(authorization.slice(7))
  if (error || !data.user || data.user.is_anonymous) throw createError({ statusCode: 401, message: 'Your session has ended. Sign in again.' })
  return { id: data.user.id, authorization }
}
async function readConnection(event: H3Event, user: string): Promise<Connection | null> {
  const { data, error } = await googleStore(event).from('google_connections').select('generation,encrypted_grant,scopes,status').eq('owner_id', user).maybeSingle()
  if (error) throw createError({ statusCode: 503, message: 'Google connection storage is unavailable.' })
  return data
}
async function readGrant(event: H3Event, user: string) {
  const config = configuration(event)
  const connection = await readConnection(event, user)
  if (connection) {
    if (connection.status !== 'connected') return null
    const grant = unseal<Grant>(connection.encrypted_grant, config.googleCookieKey, `htp_google_grant:${user}`)
    return grant?.user === user && grant.refresh ? grant : null
  }
  // One-time migration of a previously connected browser after verifying its
  // Supabase identity. The refresh grant then works without that browser.
  const grant = unseal<Grant>(getCookie(event, grantCookie), config.googleCookieKey, grantCookie)
  if (grant?.user !== user || grant.until <= Date.now() || !grant.refresh) return null
  await writeGrant(event, grant, true)
  return grant
}
async function writeGrant(event: H3Event, grant: Grant, migrate = false) {
  const config = configuration(event)
  const scopes = grant.scopes ?? [scope]
  const { error } = await googleStore(event).from('google_connections').upsert({
    owner_id: grant.user, generation: randomUUID(),
    encrypted_grant: seal({ user: grant.user, refresh: grant.refresh, scopes }, config.googleCookieKey, `htp_google_grant:${grant.user}`),
    scopes, status: 'connected', updated_at: new Date().toISOString(),
  }, { onConflict: 'owner_id', ignoreDuplicates: migrate })
  if (error) throw createError({ statusCode: 503, message: 'Could not save your Google connection.' })
  deleteCookie(event, grantCookie, { path: '/' })
}
export async function googleConnection(event: H3Event) {
  const user = await requireDashboardUser(event)
  const config = useRuntimeConfig(event)
  const configured = !!config.googleClientId && !!config.googleClientSecret && !!config.googleCookieKey && !!config.supabaseServiceRoleKey
  if (configured) await readGrant(event, user.id)
  const connection = configured ? await readConnection(event, user.id) : null
  return { connected: !!connection && connection.status !== 'disconnected', configured, analytics: !!connection?.scopes.includes(scope), search: !!connection?.scopes.includes(searchScope), business: !!connection?.scopes.includes(businessScope), reauthorizationRequired: connection?.status === 'reauthorization_required' }
}
export async function startGoogle(event: H3Event) {
  const user = await requireDashboardUser(event)
  const config = configuration(event)
  const origin = getHeader(event, 'origin')
  if (origin && origin !== config.origin) throw createError({ statusCode: 403, message: 'Open this dashboard directly to connect Google.' })
  const oauth = client(event)
  const codes = await oauth.generateCodeVerifierAsync()
  const state = randomBytes(32).toString('base64url')
  setCookie(event, stateCookie, seal({ user: user.id, state, verifier: codes.codeVerifier, until: Date.now() + 600_000 } satisfies Pending, config.googleCookieKey, stateCookie), options(event, 600))
  return { url: oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [scope, searchScope, businessScope], state, code_challenge: codes.codeChallenge, code_challenge_method: CodeChallengeMethod.S256 }) }
}
export async function finishGoogle(event: H3Event) {
  const config = configuration(event)
  const pending = unseal<Pending>(getCookie(event, stateCookie), config.googleCookieKey, stateCookie)
  deleteCookie(event, stateCookie, { path: '/' })
  const query = getQuery(event)
  const state = typeof query.state === 'string' ? query.state : ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !pending || pending.until < Date.now() || state.length !== pending.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) return sendRedirect(event, '/connections?google=invalid_state')
  if (query.error || typeof query.code !== 'string') return sendRedirect(event, '/connections?google=denied')
  try {
    const { tokens } = await client(event).getToken({ code: query.code, codeVerifier: pending.verifier })
    if (!tokens.refresh_token || !tokens.scope?.split(' ').some(value => [scope, searchScope, businessScope].includes(value))) return sendRedirect(event, '/connections?google=missing_scope')
    await writeGrant(event, { user: pending.user, refresh: tokens.refresh_token, scopes: tokens.scope?.split(' '), until: 0 })
    return sendRedirect(event, '/?google=connected')
  } catch { return sendRedirect(event, '/connections?google=failed') }
}
export async function googleAccessToken(event: H3Event, user: string, service: 'analytics' | 'search' = 'analytics') {
  const grant = await readGrant(event, user)
  if (!grant) throw createError({ statusCode: 401, message: 'Connect your Google account to load reports.', data: { code: 'google_authorization_required' } })
  const required = service === 'search' ? searchScope : scope
  if (!(grant.scopes ?? [scope]).includes(required)) throw createError({ statusCode: 403, message: `Reconnect Google and grant ${service === 'search' ? 'Search Console' : 'Analytics'} access.`, data: { code: 'google_scope_required' } })
  if (grant.access && (grant.expires ?? 0) > Date.now() + 60_000) return grant.access
  try {
    const oauth = client(event)
    oauth.setCredentials({ refresh_token: grant.refresh })
    const { credentials } = await oauth.refreshAccessToken()
    if (!credentials.access_token) throw new Error('No token')
    // Access tokens remain request-local. Only persist a rotated refresh token,
    // fenced against concurrent reconnects/disconnects using the generation.
    if (credentials.refresh_token && credentials.refresh_token !== grant.refresh) {
      const connection = await readConnection(event, user)
      if (connection && unseal<Grant>(connection.encrypted_grant, configuration(event).googleCookieKey, `htp_google_grant:${user}`)?.refresh === grant.refresh) {
        const { error } = await googleStore(event).rpc('rotate_google_grant', { p_owner_id: user, p_generation: connection.generation, p_encrypted_grant: seal({ user, refresh: credentials.refresh_token, scopes: grant.scopes }, configuration(event).googleCookieKey, `htp_google_grant:${user}`) })
        if (error) throw new Error('Could not persist rotated grant')
      }
    }
    return credentials.access_token
  } catch { throw createError({ statusCode: 401, message: 'Google authorization expired. Reconnect your account.', data: { code: 'google_authorization_required' } }) }
}
export async function disconnectGoogle(event: H3Event) {
  const user = await requireDashboardUser(event)
  // Retain an empty tombstone so a legacy cookie on another device cannot
  // silently restore a connection after an account-wide disconnect.
  const { error } = await googleStore(event).from('google_connections').upsert({ owner_id: user.id, generation: randomUUID(), encrypted_grant: '', scopes: [], status: 'disconnected', updated_at: new Date().toISOString() })
  if (error) throw createError({ statusCode: 503, message: 'Could not disconnect Google. Try again.' })
  deleteCookie(event, grantCookie, { path: '/' })
  deleteCookie(event, stateCookie, { path: '/' })
  return { connected: false }
}
