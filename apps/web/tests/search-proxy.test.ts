import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
const mocks = vi.hoisted(() => ({ user: vi.fn(), token: vi.fn(), raw: vi.fn() }))
vi.mock('../server/utils/google', () => ({ requireDashboardUser: mocks.user, googleAccessToken: mocks.token }))
import { proxySearch } from '../server/utils/search'
const event = {} as H3Event
const id = 'a19a3adb-148d-4714-9278-c2d709fe0ad1'
beforeEach(() => {
  mocks.user.mockResolvedValue({ id: 'owner', authorization: 'Bearer app-token' })
  mocks.token.mockResolvedValue('private-google-token')
  mocks.raw.mockResolvedValue({ status: 200, _data: { properties: [] } })
  vi.stubGlobal('getRouterParam', () => id)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiBaseUrl: 'https://api.example/' }))
  vi.stubGlobal('readBody', async () => ({ site_url: 'sc-domain:example.com', url: 'https://example.com/jobs/1' }))
  vi.stubGlobal('setResponseStatus', vi.fn())
  vi.stubGlobal('createError', (v: object) => Object.assign(new Error(), v))
  vi.stubGlobal('$fetch', { raw: mocks.raw })
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })
it('reads saved dashboard reports without refreshing or forwarding Google tokens', async () => {
  await proxySearch(event, 'dashboard')
  expect(mocks.token).not.toHaveBeenCalled()
  expect(mocks.raw).toHaveBeenCalledWith(`https://api.example/websites/${id}/search/dashboard`, expect.objectContaining({ method: 'POST', retry: 0, redirect: 'error', timeout: 35000, headers: { Authorization: 'Bearer app-token' } }))
})
it('uses read-only Search consent for inspection and propagates quota failures', async () => {
  mocks.raw.mockResolvedValue({ status: 429, _data: { code: 'google_quota_exceeded' } })
  expect(await proxySearch(event, 'inspect')).toEqual({ code: 'google_quota_exceeded' })
  expect(mocks.token).toHaveBeenCalledWith(event, 'owner', 'search')
  expect(setResponseStatus).toHaveBeenCalledWith(event, 429)
})
it('rejects route injection and missing consent before contacting the API', async () => {
  vi.stubGlobal('getRouterParam', () => '../other')
  await expect(proxySearch(event, 'dashboard')).rejects.toMatchObject({ statusCode: 400 })
  expect(mocks.raw).not.toHaveBeenCalled()
  vi.stubGlobal('getRouterParam', () => id)
  mocks.token.mockRejectedValue({ statusCode: 403 })
  await expect(proxySearch(event, 'inspect')).rejects.toMatchObject({ statusCode: 403 })
  expect(mocks.raw).not.toHaveBeenCalled()
})

it('reads retained inspection history using only the owner session', async () => {
  await proxySearch(event, 'inspection-history')
  expect(mocks.token).not.toHaveBeenCalled()
  expect(mocks.raw).toHaveBeenCalledWith(`https://api.example/websites/${id}/search/inspection-history`, expect.objectContaining({ headers: { Authorization: 'Bearer app-token' } }))
})
