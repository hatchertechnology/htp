import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { seal, unseal } from '../server/utils/sealed-cookie'
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), getToken: vi.fn(), refresh: vi.fn(), read: vi.fn(), upsert: vi.fn(), rpc: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { getUser: mocks.getUser } }) }))
vi.mock('../server/utils/google-store', () => ({ googleStore: () => ({ from: () => ({ select: () => ({ eq: (field: string, owner: string) => ({ maybeSingle: () => mocks.read(owner) }) }), upsert: mocks.upsert }), rpc: mocks.rpc }) }))
vi.mock('google-auth-library', () => ({ CodeChallengeMethod: { S256: 'S256' }, OAuth2Client: class { getToken(...args: unknown[]) { return mocks.getToken(...args) } setCredentials() {} refreshAccessToken() { return mocks.refresh() } } }))
import { finishGoogle, googleConnection, googleAccessToken, requireDashboardUser, disconnectGoogle } from '../server/utils/google'
const event = {} as H3Event
const secret = Buffer.alloc(32, 4).toString('base64')
const cookie = vi.fn(), cookiesSet = vi.fn(), redirect = vi.fn()
let records: Record<string, any>
const analytics = 'https://www.googleapis.com/auth/analytics.readonly'
const search = 'https://www.googleapis.com/auth/webmasters.readonly'
function connect(owner: string, scopes = [analytics], status = 'connected') {
  records[owner] = { generation: 'generation', encrypted_grant: seal({ user: owner, refresh: 'private-refresh', scopes }, secret, `htp_google_grant:${owner}`), scopes, status }
}
beforeEach(() => {
  records = {}
  vi.stubGlobal('useRuntimeConfig', () => ({ googleClientId: 'id', googleClientSecret: 'secret', googleCookieKey: secret, supabaseServiceRoleKey: 'server-only', appOrigin: 'https://htp.hatchtech.dev', public: { supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'public' } }))
  vi.stubGlobal('getHeader', () => 'Bearer valid.user.token')
  vi.stubGlobal('getCookie', cookie); vi.stubGlobal('setCookie', cookiesSet)
  vi.stubGlobal('deleteCookie', vi.fn()); vi.stubGlobal('getQuery', () => ({})); vi.stubGlobal('sendRedirect', redirect)
  vi.stubGlobal('createError', (v: {statusCode:number;message:string}) => Object.assign(new Error(v.message), v))
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'owner', is_anonymous: false } }, error: null })
  mocks.read.mockImplementation(async owner => ({ data: records[owner] ?? null, error: null }))
  mocks.upsert.mockImplementation(async record => { records[record.owner_id] = record; return { error: null } })
  mocks.refresh.mockResolvedValue({ credentials: { access_token: 'request-local-access' } })
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })
it('requires a verified non-anonymous Supabase identity', async () => {
  vi.stubGlobal('getHeader', () => undefined)
  await expect(requireDashboardUser(event)).rejects.toMatchObject({ statusCode: 401 })
  expect(mocks.getUser).not.toHaveBeenCalled()
  vi.stubGlobal('getHeader', () => 'Bearer valid.user.token')
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'owner', is_anonymous: true } }, error: null })
  await expect(requireDashboardUser(event)).rejects.toMatchObject({ statusCode: 401 })
})
it('isolates stored credentials by verified user without returning secrets', async () => {
  connect('other')
  expect(await googleConnection(event)).toMatchObject({ connected: false })
  connect('owner')
  expect(await googleConnection(event)).toEqual({ connected: true, configured: true, analytics: true, search: false, reauthorizationRequired: false })
  expect(JSON.stringify(await googleConnection(event))).not.toContain('private-refresh')
})
it('rejects OAuth state before exchanging a code', async () => {
  cookie.mockReturnValue(seal({ user: 'owner', state: 'a'.repeat(43), verifier: 'pkce', until: Date.now() + 10000 }, secret, 'htp_google_state'))
  vi.stubGlobal('getQuery', () => ({ state: 'b'.repeat(43), code: 'code' }))
  await finishGoogle(event)
  expect(mocks.getToken).not.toHaveBeenCalled()
  expect(redirect).toHaveBeenCalledWith(event, '/connections?google=invalid_state')
})
it('uses PKCE and persists only an owner-bound encrypted refresh grant', async () => {
  cookie.mockReturnValue(seal({ user: 'owner', state: 'a'.repeat(43), verifier: 'pkce', until: Date.now() + 10000 }, secret, 'htp_google_state'))
  vi.stubGlobal('getQuery', () => ({ state: 'a'.repeat(43), code: 'code' }))
  mocks.getToken.mockResolvedValue({ tokens: { refresh_token: 'refresh-private', access_token: 'access-private', scope: analytics } })
  await finishGoogle(event)
  expect(mocks.getToken).toHaveBeenCalledWith({ code: 'code', codeVerifier: 'pkce' })
  const stored = records.owner
  expect(stored.encrypted_grant).not.toContain('refresh-private')
  expect(unseal(stored.encrypted_grant, secret, 'htp_google_grant:owner')).toEqual({ user: 'owner', refresh: 'refresh-private', scopes: [analytics] })
  expect(unseal(stored.encrypted_grant, secret, 'htp_google_grant:other')).toBeNull()
  expect(cookiesSet).not.toHaveBeenCalled()
  expect(redirect).toHaveBeenCalledWith(event, '/?google=connected')
})
it('requires service-specific consent and keeps access tokens request-local', async () => {
  connect('owner', [search])
  expect(await googleConnection(event)).toMatchObject({ analytics: false, search: true })
  expect(await googleAccessToken(event, 'owner', 'search')).toBe('request-local-access')
  await expect(googleAccessToken(event, 'owner', 'analytics')).rejects.toMatchObject({ statusCode: 403 })
  await expect(googleAccessToken(event, 'other', 'search')).rejects.toMatchObject({ statusCode: 401 })
  expect(mocks.upsert).not.toHaveBeenCalled()
})
it('migrates valid legacy cookies but never revives a disconnected account', async () => {
  cookie.mockReturnValue(seal({ user: 'owner', refresh: 'legacy-private', until: Date.now() + 10000 }, secret, 'htp_google'))
  expect(await googleConnection(event)).toMatchObject({ connected: true, analytics: true })
  expect(unseal(records.owner.encrypted_grant, secret, 'htp_google_grant:owner')).toMatchObject({ refresh: 'legacy-private' })
  await disconnectGoogle(event)
  expect(records.owner).toMatchObject({ status: 'disconnected', encrypted_grant: '', scopes: [] })
  expect(await googleConnection(event)).toMatchObject({ connected: false, analytics: false })
  await expect(googleAccessToken(event, 'owner')).rejects.toMatchObject({ statusCode: 401 })
})
it('reports expired background grants while retaining service availability for saved reports', async () => {
  connect('owner', [analytics, search], 'reauthorization_required')
  expect(await googleConnection(event)).toMatchObject({ connected: true, analytics: true, search: true, reauthorizationRequired: true })
  await expect(googleAccessToken(event, 'owner')).rejects.toMatchObject({ statusCode: 401 })
  expect(mocks.refresh).not.toHaveBeenCalled()
})
it('does not claim connection success if durable storage fails', async () => {
  cookie.mockReturnValue(seal({ user: 'owner', state: 'a'.repeat(43), verifier: 'pkce', until: Date.now() + 10000 }, secret, 'htp_google_state'))
  vi.stubGlobal('getQuery', () => ({ state: 'a'.repeat(43), code: 'code' }))
  mocks.getToken.mockResolvedValue({ tokens: { refresh_token: 'refresh-private', scope: analytics } })
  mocks.upsert.mockResolvedValue({ error: new Error('unavailable') })
  await finishGoogle(event)
  expect(redirect).toHaveBeenCalledWith(event, '/connections?google=failed')
})
