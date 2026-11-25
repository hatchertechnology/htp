import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ref } from 'vue'
import { useWebsites } from '../app/composables/useWebsites'

const SITE = '00000000-0000-0000-0000-000000000001'
const created = { id: '00000000-0000-0000-0000-000000000009', fqdn: 'new.example.com', ga4_property_id: null }
const calls: { url: string; options: Record<string, unknown> }[] = []
const user = ref<{ id: string } | null>({ id: 'owner' })
let fetchResult: unknown = created
let staticDashboard = false

beforeEach(() => {
  calls.length = 0
  user.value = { id: 'owner' }
  fetchResult = created
  staticDashboard = false
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('useAuth', () => ({ user, accessToken: async () => user.value ? 'owner-token' : null }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { staticDashboard, apiBaseUrl: 'https://api.example.test' } }))
  vi.stubGlobal('onBeforeUnmount', vi.fn())
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options: Record<string, unknown>) => {
    calls.push({ url, options })
    return fetchResult
  }))
})
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals() })

it('creates a website and returns the created record instead of a bare boolean', async () => {
  const websites = useWebsites()
  expect(await websites.mutate('POST', undefined, 'new.example.com')).toEqual(created)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe('/api/websites')
  expect(calls[0]!.options).toMatchObject({ method: 'POST', body: { fqdn: 'new.example.com' }, retry: 0, headers: { Authorization: 'Bearer owner-token' } })
})

it('updates the selected website and returns the new record', async () => {
  fetchResult = { id: SITE, fqdn: 'www.example.com', ga4_property_id: '557292489' }
  const websites = useWebsites()
  expect(await websites.mutate('PATCH', SITE, 'www.example.com')).toEqual({ id: SITE, fqdn: 'www.example.com', ga4_property_id: '557292489' })
  expect(calls[0]!.url).toBe(`/api/websites/${SITE}`)
  expect(calls[0]!.options).toMatchObject({ method: 'PATCH', body: { fqdn: 'www.example.com' } })
})

it('deletes without a body and returns the removed record for the selection fallback', async () => {
  fetchResult = null
  const websites = useWebsites()
  expect(await websites.mutate('DELETE', SITE, 'old.example.com')).toEqual({ id: SITE, fqdn: 'old.example.com' })
  expect(calls[0]!.url).toBe(`/api/websites/${SITE}`)
  expect(calls[0]!.options).toMatchObject({ method: 'DELETE' })
  expect(calls[0]!.options.body).toBeUndefined()
})

it('maps the owner API origin in the static build', async () => {
  staticDashboard = true
  const websites = useWebsites()
  await websites.mutate('POST', undefined, 'new.example.com')
  expect(calls[0]!.url).toBe('https://api.example.test/websites')
})

it('returns null and reports the message when a mutation fails or the session ends', async () => {
  vi.stubGlobal('$fetch', vi.fn(async () => { throw { data: { error: 'Already exists' } } }))
  const websites = useWebsites()
  expect(await websites.mutate('POST', undefined, 'new.example.com')).toBeNull()
  expect(websites.error.value).toBe('Already exists')
  user.value = null
  expect(await websites.mutate('POST', undefined, 'new.example.com')).toBeNull()
})

it('reports a second concurrent save instead of silently doing nothing', async () => {
  let finish: (value: unknown) => void = () => {}
  vi.stubGlobal('$fetch', vi.fn(() => new Promise(resolve => { finish = resolve })))
  const websites = useWebsites()
  const first = websites.mutate('POST', undefined, 'one.example.com')
  expect(await websites.mutate('POST', undefined, 'two.example.com')).toBeNull()
  expect(websites.error.value).toBe('A change is already being saved. Try again in a moment.')
  finish(created)
  expect(await first).toEqual(created)
})

it('does not auto-load the website list for the settings page', () => {
  useWebsites()
  expect(calls).toHaveLength(0)
  const source = readFileSync(new URL('../app/composables/useWebsites.ts', import.meta.url), 'utf8')
  expect(source).not.toMatch(/onMounted\(/)
  expect(source).not.toMatch(/watch\(\(\) => auth\.user/)
})
