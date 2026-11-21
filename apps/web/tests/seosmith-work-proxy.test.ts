import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
const mocks = vi.hoisted(() => ({ user: vi.fn(), raw: vi.fn() }))
vi.mock('../server/utils/google', () => ({ requireDashboardUser: mocks.user }))
import { proxySeosmithWork } from '../server/utils/seosmith-work'
const event = {} as H3Event, id = '00000000-0000-0000-0000-000000000001'
beforeEach(() => {
  mocks.user.mockResolvedValue({ authorization: 'Bearer session' }); mocks.raw.mockResolvedValue({ status: 200, _data: [] })
  vi.stubGlobal('$fetch', { raw: mocks.raw }); vi.stubGlobal('getRouterParam', () => id)
  vi.stubGlobal('readBody', () => ({ finding_index: 0, work: { status: 'open' } }))
  vi.stubGlobal('useRuntimeConfig', () => ({ apiBaseUrl: 'https://api.example.test/' }))
  vi.stubGlobal('setResponseStatus', vi.fn()); vi.stubGlobal('setHeader', vi.fn())
  vi.stubGlobal('createError', (value: { statusCode: number; message: string }) => Object.assign(new Error(value.message), value))
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })
it('forwards saved work with the verified user and a fixed path', async () => {
  await proxySeosmithWork(event, 'save')
  expect(mocks.raw).toHaveBeenCalledWith(`https://api.example.test/websites/${id}/seo/audits/${id}/work`, expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer session' }, retry: 0, redirect: 'error' }))
})
it('rejects unauthenticated and invalid identifiers before forwarding', async () => {
  mocks.user.mockRejectedValueOnce(new Error('unauthorized')); await expect(proxySeosmithWork(event, 'list')).rejects.toThrow(); expect(mocks.raw).not.toHaveBeenCalled()
  vi.stubGlobal('getRouterParam', () => '../other'); await expect(proxySeosmithWork(event, 'attempt')).rejects.toMatchObject({ statusCode: 400 }); expect(mocks.raw).not.toHaveBeenCalled()
})
