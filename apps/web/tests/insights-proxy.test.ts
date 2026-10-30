import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
const mocks = vi.hoisted(() => ({ user: vi.fn(), raw: vi.fn() }))
vi.mock('../server/utils/google', () => ({ requireDashboardUser: mocks.user }))
import { proxyInsight } from '../server/utils/insights'
const event = {} as H3Event
const id = 'a19a3adb-148d-4714-9278-c2d709fe0ad1'
beforeEach(() => {
  mocks.user.mockResolvedValue({ id: 'owner', authorization: 'Bearer app-token' })
  mocks.raw.mockResolvedValue({ status: 200, _data: { data: null, sync: { state: 'pending' } } })
  vi.stubGlobal('getRouterParam', () => id)
  vi.stubGlobal('useRuntimeConfig', () => ({ apiBaseUrl: 'https://api.example' }))
  vi.stubGlobal('readBody', async () => ({ kind: 'crux', property_id: 'PHONE', start_date: '2026-10-01', end_date: '2026-10-28' }))
  vi.stubGlobal('setResponseStatus', vi.fn())
  vi.stubGlobal('createError', (v: object) => Object.assign(new Error(), v))
  vi.stubGlobal('$fetch', { raw: mocks.raw })
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })
it('forwards only application identity to the database-backed API', async () => {
  await proxyInsight(event, 'insights/report')
  expect(mocks.raw).toHaveBeenCalledWith(`https://api.example/websites/${id}/insights/report`, expect.objectContaining({ method: 'POST', retry: 0, redirect: 'error', headers: { Authorization: 'Bearer app-token' } }))
})
it('uses the binding endpoint and preserves API authorization errors', async () => {
  mocks.raw.mockResolvedValue({ status: 403, _data: { error: 'No access' } })
  expect(await proxyInsight(event, 'business/location')).toEqual({ error: 'No access' })
  expect(mocks.raw.mock.calls[0]![1].method).toBe('PUT')
  expect(setResponseStatus).toHaveBeenCalledWith(event, 403)
})
it('rejects missing identity or route injection before any API call', async () => {
  mocks.user.mockRejectedValueOnce({ statusCode: 401 })
  await expect(proxyInsight(event, 'insights/history')).rejects.toMatchObject({ statusCode: 401 })
  vi.stubGlobal('getRouterParam', () => '../other')
  await expect(proxyInsight(event, 'insights/history')).rejects.toMatchObject({ statusCode: 400 })
  expect(mocks.raw).not.toHaveBeenCalled()
})
