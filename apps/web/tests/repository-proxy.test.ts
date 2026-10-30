import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
const mocks = vi.hoisted(() => ({ user: vi.fn(), raw: vi.fn() }))
vi.mock('../server/utils/google', () => ({ requireDashboardUser: mocks.user }))
import { proxyRepository } from '../server/utils/repository'
const event = {} as H3Event
const id = '00000000-0000-0000-0000-000000000001'
beforeEach(() => {
  mocks.user.mockResolvedValue({ authorization: 'Bearer current.user.token' })
  mocks.raw.mockResolvedValue({ status: 200, _data: { commits: [], repository: null } })
  vi.stubGlobal('$fetch', { raw: mocks.raw })
  vi.stubGlobal('getRouterParam', () => id)
  vi.stubGlobal('getMethod', () => 'GET')
  vi.stubGlobal('getQuery', () => ({ start_date: '2026-10-01', end_date: '2026-10-30' }))
  vi.stubGlobal('useRuntimeConfig', () => ({ apiBaseUrl: 'https://api.example.test' }))
  vi.stubGlobal('setResponseStatus', vi.fn())
  vi.stubGlobal('createError', (options: { statusCode: number; message: string }) => Object.assign(new Error(options.message), options))
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })
it('reads saved history only from the fixed API with the current user token', async () => {
  expect(await proxyRepository(event)).toEqual({ commits: [], repository: null })
  expect(mocks.raw).toHaveBeenCalledWith(`https://api.example.test/websites/${id}/repository`, expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer current.user.token' }, redirect: 'error', retry: 0, query: { start_date: '2026-10-01', end_date: '2026-10-30' } }))
})
it('does not proxy requests without a verified session', async () => {
  mocks.user.mockRejectedValue({ statusCode: 401 })
  await expect(proxyRepository(event)).rejects.toMatchObject({ statusCode: 401 })
  expect(mocks.raw).not.toHaveBeenCalled()
})
it('rejects invalid website IDs before reaching the API', async () => {
  vi.stubGlobal('getRouterParam', () => '../other')
  await expect(proxyRepository(event)).rejects.toMatchObject({ statusCode: 400 })
  expect(mocks.raw).not.toHaveBeenCalled()
})
