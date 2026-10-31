import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { seal, unseal } from '../server/utils/sealed-cookie'
const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn(), upsert: vi.fn(), fetch: vi.fn(), raw: vi.fn() }))
vi.mock('../server/utils/google', () => ({ requireDashboardUser: mocks.user }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => ({ select: () => ({ eq: (_: string, user: string) => ({ maybeSingle: () => mocks.read(user) }) }), upsert: mocks.upsert }) }) }))
import { startBing, finishBing, bingConnection, disconnectBing, proxyBing } from '../server/utils/bing'
const event = {} as H3Event
const key = Buffer.alloc(32,7).toString('base64')
const cookie = vi.fn(), set = vi.fn(), redirect = vi.fn()
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('useRuntimeConfig', () => ({ bingClientId:'client',bingClientSecret:'secret',bingCookieKey:key,supabaseServiceRoleKey:'private-service',appOrigin:'https://htp.example',apiBaseUrl:'https://api.example', public:{supabaseUrl:'https://db.example'} }))
  mocks.user.mockResolvedValue({id:'owner',authorization:'Bearer owner-token'})
  mocks.read.mockResolvedValue({data:{status:'connected'},error:null})
  mocks.upsert.mockResolvedValue({error:null})
  mocks.fetch.mockResolvedValue(Response.json({refresh_token:'private-refresh',access_token:'private-access'}))
  mocks.raw.mockResolvedValue({status:202,_data:{code:'report_pending'}})
  vi.stubGlobal('fetch',mocks.fetch); vi.stubGlobal('$fetch',{raw:mocks.raw})
  vi.stubGlobal('getCookie',cookie); vi.stubGlobal('setCookie',set); vi.stubGlobal('deleteCookie',vi.fn())
  vi.stubGlobal('getQuery',() => ({state:'a'.repeat(43),code:'code'})); vi.stubGlobal('sendRedirect',redirect)
  vi.stubGlobal('getHeader',() => 'https://htp.example'); vi.stubGlobal('getRouterParam',() => '00000000-0000-0000-0000-000000000003')
  vi.stubGlobal('setResponseStatus',vi.fn()); vi.stubGlobal('createError',(v:{message:string}) => Object.assign(new Error(v.message),v))
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })
it('requests read-only consent with encrypted owner-bound state and rejects foreign origins',async () => {
  const result = await startBing(event), url = new URL(result.url)
  expect(url.origin).toBe('https://www.bing.com'); expect(url.searchParams.get('scope')).toBe('webmaster.read')
  expect(url.searchParams.get('redirect_uri')).toBe('https://htp.example/auth/bing/callback')
  expect(unseal(set.mock.calls[0]![2],key,'htp_bing_state')).toMatchObject({user:'owner',state:url.searchParams.get('state')})
  expect(set.mock.calls[0]![3]).toMatchObject({httpOnly:true,secure:true,sameSite:'lax'})
  vi.stubGlobal('getHeader',() => 'https://evil.example')
  await expect(startBing(event)).rejects.toMatchObject({statusCode:403})
})
it('rejects expired or mismatched state before making token requests',async () => {
  for (const pending of [{state:'b'.repeat(43),until:Date.now()+10000},{state:'a'.repeat(43),until:0}]) {
    cookie.mockReturnValue(seal({user:'owner',...pending},key,'htp_bing_state')); await finishBing(event)
  }
  expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled()
})
it('saves only an owner-bound encrypted refresh token and does not claim success on storage failure',async () => {
  cookie.mockReturnValue(seal({user:'owner',state:'a'.repeat(43),until:Date.now()+10000},key,'htp_bing_state'))
  await finishBing(event)
  const row = mocks.upsert.mock.calls[0]![0]
  expect(row.owner_id).toBe('owner'); expect(JSON.stringify(row)).not.toContain('private-refresh'); expect(JSON.stringify(row)).not.toContain('private-access')
  expect(unseal(row.encrypted_grant,key,'htp_bing_grant:owner')).toMatchObject({refresh:'private-refresh'})
  expect(unseal(row.encrypted_grant,key,'htp_bing_grant:other')).toBeNull()
  expect(redirect).toHaveBeenLastCalledWith(event,'/connections?bing=connected')
  mocks.upsert.mockResolvedValue({error:new Error('storage')})
  mocks.fetch.mockResolvedValue(Response.json({refresh_token:'private-refresh'}))
  await finishBing(event)
  expect(redirect).toHaveBeenLastCalledWith(event,'/connections?bing=failed')
  expect(console.error).toHaveBeenLastCalledWith('Bing OAuth callback failed (save_connection; HTTP 200).')
})
it('reads only the authenticated connection status and disconnects account-wide',async () => {
  expect(await bingConnection(event)).toEqual({configured:true,connected:true,reauthorizationRequired:false})
  expect(mocks.read).toHaveBeenCalledWith('owner')
  mocks.read.mockResolvedValue({data:{status:'reauthorization_required'},error:null})
  expect(await bingConnection(event)).toMatchObject({reauthorizationRequired:true})
  await disconnectBing(event)
  expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({owner_id:'owner',status:'disconnected',encrypted_grant:''}))
})
it('proxies saved data using the user identity without provider credentials and rejects injected IDs',async () => {
  expect(await proxyBing(event)).toEqual({code:'report_pending'})
  expect(mocks.raw).toHaveBeenCalledWith('https://api.example/websites/00000000-0000-0000-0000-000000000003/bing/dashboard',expect.objectContaining({headers:{Authorization:'Bearer owner-token'},body:{},retry:0,redirect:'error'}))
  expect(setResponseStatus).toHaveBeenCalledWith(event,202)
  vi.stubGlobal('getRouterParam',() => '../other')
  await expect(proxyBing(event)).rejects.toMatchObject({statusCode:400})
  expect(mocks.fetch).not.toHaveBeenCalled()
})
