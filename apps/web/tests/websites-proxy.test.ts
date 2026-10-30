import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { proxyWebsites } from '../server/utils/websites'

const event = {} as H3Event
const raw = vi.fn()
const body = vi.fn()
const method = vi.fn()
const authorization = vi.fn()
const status = vi.fn()

beforeEach(() => {
  vi.stubGlobal('getMethod', method.mockReturnValue('POST'))
  vi.stubGlobal('getHeader', authorization.mockReturnValue('Bearer fixture.user.token'))
  vi.stubGlobal('readBody', body.mockResolvedValue({ fqdn: ' WWW.DreamCleanMacon.COM. ' }))
  vi.stubGlobal('getQuery', () => ({}))
  vi.stubGlobal('useRuntimeConfig', () => ({ apiBaseUrl: 'https://api.example.com' }))
  vi.stubGlobal('setHeader', vi.fn())
  vi.stubGlobal('setResponseStatus', status)
  vi.stubGlobal('createError', (options: { statusCode: number; message?: string }) => Object.assign(new Error(options.message), options))
  vi.stubGlobal('$fetch', { raw: raw.mockResolvedValue({ status: 201, _data: { id: 'website-id', fqdn: 'www.dreamcleanmacon.com' } }) })
})
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

it('sends only normalized domain data and the user token to the fixed API', async () => {
  expect(await proxyWebsites(event)).toMatchObject({ fqdn: 'www.dreamcleanmacon.com' })
  expect(raw).toHaveBeenCalledWith('https://api.example.com/websites', expect.objectContaining({ method: 'POST', body: { fqdn: 'www.dreamcleanmacon.com' }, headers: { Authorization: 'Bearer fixture.user.token' }, retry: 0 }))
  expect(status).toHaveBeenCalledWith(event, 201)
})
it('rejects missing authentication before sending a request', async () => {
  authorization.mockReturnValue(undefined)
  await expect(proxyWebsites(event)).rejects.toMatchObject({ statusCode: 401 })
  expect(raw).not.toHaveBeenCalled()
})
it('rejects URLs and ownership fields', async () => {
  for (const input of [{ fqdn: 'https://example.com' }, { fqdn: 'example.com', owner_id: 'another-user' }]) {
    body.mockResolvedValue(input)
    await expect(proxyWebsites(event)).rejects.toMatchObject({ statusCode: 400 })
  }
  expect(raw).not.toHaveBeenCalled()
})
it('rejects invalid IDs and unsupported methods', async () => {
  method.mockReturnValue('DELETE')
  await expect(proxyWebsites(event, '../secrets')).rejects.toMatchObject({ statusCode: 400 })
  await expect(proxyWebsites(event)).rejects.toMatchObject({ statusCode: 405 })
})
it('preserves duplicate errors and empty successful deletes', async () => {
  raw.mockResolvedValueOnce({ status: 409, _data: { error: 'Already exists' } })
  expect(await proxyWebsites(event)).toEqual({ error: 'Already exists' })
  expect(status).toHaveBeenLastCalledWith(event, 409)
  method.mockReturnValue('DELETE')
  raw.mockResolvedValueOnce({ status: 204 })
  expect(await proxyWebsites(event, '00000000-0000-0000-0000-000000000001')).toBeNull()
  expect(status).toHaveBeenLastCalledWith(event, 204)
})
