import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
const mocks = vi.hoisted(() => ({ user: vi.fn(), raw: vi.fn() }))
vi.mock('../server/utils/google', () => ({ requireDashboardUser: mocks.user }))
import { proxySeosmith } from '../server/utils/seosmith'
const event = {} as H3Event, id = '00000000-0000-0000-0000-000000000001'
beforeEach(() => {
  mocks.user.mockResolvedValue({ authorization: 'Bearer current.user.token' }); mocks.raw.mockResolvedValue({ status: 200, _data: { items: [], has_more: false, next_cursor: null } })
  vi.stubGlobal('$fetch', { raw: mocks.raw }); vi.stubGlobal('getRouterParam', (_e: H3Event, key: string) => key === 'id' ? id : '00000000-0000-0000-0000-000000000002')
  vi.stubGlobal('getMethod', () => 'GET'); vi.stubGlobal('getQuery', () => ({ limit: 50, before: '2026-10-31T00:00:00Z', before_id: id, url: 'https://evil.invalid/' }))
  vi.stubGlobal('useRuntimeConfig', () => ({ apiBaseUrl: 'https://api.example.test/' })); vi.stubGlobal('setResponseStatus', vi.fn()); vi.stubGlobal('setHeader', vi.fn())
  vi.stubGlobal('createError', (options: { statusCode: number; message: string }) => Object.assign(new Error(options.message), options))
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })
it('forwards only bounded history queries to the fixed backend with verified identity', async () => {
  await proxySeosmith(event, 'history')
  expect(mocks.raw).toHaveBeenCalledWith(`https://api.example.test/websites/${id}/seo/audits`, expect.objectContaining({ headers: { Authorization: 'Bearer current.user.token' }, query: { limit: 50, before: '2026-10-31T00:00:00Z', before_id: id }, redirect: 'error', retry: 0 }))
})
it('does not forward unauthenticated or invalid-site requests', async () => {
  mocks.user.mockRejectedValueOnce({ statusCode: 401 }); await expect(proxySeosmith(event, 'history')).rejects.toMatchObject({ statusCode: 401 }); expect(mocks.raw).not.toHaveBeenCalled()
  vi.stubGlobal('getRouterParam', () => '../other'); await expect(proxySeosmith(event, 'history')).rejects.toMatchObject({ statusCode: 400 })
})
it('imports original report text only after authentication, without accepting worker keys or arbitrary URLs', async () => {
  vi.stubGlobal('getMethod', () => 'POST'); vi.stubGlobal('readBody', () => ({ report_json: '{"schema_version":1}' }))
  await proxySeosmith(event, 'import'); expect(mocks.raw).toHaveBeenCalledWith(`https://api.example.test/websites/${id}/seo/audits/import`, expect.objectContaining({ method: 'POST', body: { report_json: '{"schema_version":1}' } }))
  vi.stubGlobal('readBody', () => ({ report_json: '{}', token: 'no' })); await expect(proxySeosmith(event, 'import')).rejects.toMatchObject({ statusCode: 400 })
})
it('round-trips expanded evidence and preserves rejected import status without a receipt', async () => {
  const { readFile } = await import('node:fs/promises')
  const report_json = await readFile(new URL('../../../supabase/tests/fixtures/seosmith-expanded.json', import.meta.url), 'utf8')
  vi.stubGlobal('getMethod', () => 'POST'); vi.stubGlobal('readBody', () => ({ report_json }))
  mocks.raw.mockResolvedValueOnce({ status: 400, _data: { error: 'report_limit' } })
  expect(await proxySeosmith(event, 'import')).toEqual({ error: 'report_limit' })
  expect(setResponseStatus).toHaveBeenCalledWith(event, 400)
  expect(mocks.raw).toHaveBeenLastCalledWith(`https://api.example.test/websites/${id}/seo/audits/import`, expect.objectContaining({ body: { report_json } }))
  vi.stubGlobal('getMethod', () => 'GET')
  const detail = { report: JSON.parse(report_json), report_json }
  mocks.raw.mockResolvedValueOnce({ status: 200, _data: detail })
  expect(await proxySeosmith(event, 'detail')).toEqual(detail)
})
