import { afterEach, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, watch } from 'vue'
import { useWorkspace } from '../app/composables/useWorkspace'
import { providerAuthorizationUrl, resolveProviderConnectionPath } from '../shared/utils/provider-connection-client'
const base = 'https://api.example.test'
afterEach(() => vi.unstubAllGlobals())
it.each(['google', 'bing'])('maps only %s connection GET/DELETE', provider => {
  const path = `/api/${provider}/connection`
  for (const method of ['GET', 'DELETE']) {
    expect(resolveProviderConnectionPath(path, method, true, `${base}/`)).toBe(`${base}/providers/${provider}/connection`)
    expect(resolveProviderConnectionPath(path, method, false, undefined)).toBe(path)
  }
  for (const other of [`/api/${provider}/callback`, `${path}/other`]) expect(resolveProviderConnectionPath(other, 'GET', true, undefined)).toBe(other)
  expect(resolveProviderConnectionPath(path, 'POST', true, undefined)).toBe(path)
  expect(() => resolveProviderConnectionPath(path, 'GET', true, undefined)).toThrow(/API base URL/)
  expect(() => resolveProviderConnectionPath(path, 'GET', true, 'https://user:pass@example.test')).toThrow()
})
function setup(staticDashboard: boolean, rolloutProviderConnect = false) {
  const states = new Map<string, any>(), user = ref<{id: string} | null>({id: 'owner'})
  const fetch = vi.fn<(url: string, options: any) => Promise<any>>(async () => ({items: [], connected: true, configured: true}))
  vi.stubGlobal('useAuth', () => ({user, ready: ref(true), accessToken: async () => 'owner-token'}))
  vi.stubGlobal('useRuntimeConfig', () => ({public: {staticDashboard, rolloutProviderConnect, apiBaseUrl: base}}))
  vi.stubGlobal('useState', (key: string, init: () => unknown) => { if (!states.has(key)) states.set(key, ref(init())); return states.get(key) })
  vi.stubGlobal('computed', computed); vi.stubGlobal('watch', watch); vi.stubGlobal('onMounted', vi.fn()); vi.stubGlobal('$fetch', fetch)
  const scope = effectScope(), ws = scope.run(() => useWorkspace())!
  return {ws, user, fetch, scope}
}
const flush = async () => { await nextTick(); await Promise.resolve(); await Promise.resolve() }
it.each([true, false])('workspace selects transport and bearer (static=%s)', async mode => {
  const {ws, fetch, scope} = setup(mode)
  try {
    await flush()
    expect(fetch.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(false)
    for (const provider of ['google', 'bing']) {
      const path = `/api/${provider}/connection`, url = mode ? `${base}/providers/${provider}/connection` : path
      expect(fetch).toHaveBeenCalledWith(url, {headers: {Authorization: 'Bearer owner-token'}, retry: 0})
      await ws.request(path, {method: 'DELETE'})
      expect(fetch).toHaveBeenLastCalledWith(url, {method: 'DELETE', headers: {Authorization: 'Bearer owner-token'}, retry: 0})
      if (mode) {
        const count = fetch.mock.calls.length
        expect(ws.providerConnectAvailable).toBe(false)
        await expect(ws.request(`/api/${provider}/connect`, {method: 'POST'})).rejects.toThrow(/not available yet/)
        await expect(ws.connectProvider(provider as 'google' | 'bing')).rejects.toThrow(/not available yet/)
        expect(fetch.mock.calls.length).toBe(count)
      } else {
        expect(ws.providerConnectAvailable).toBe(true)
        fetch.mockResolvedValueOnce({url: authUrls[provider as 'google' | 'bing']})
        expect(await ws.connectProvider(provider as 'google' | 'bing')).toBe(authUrls[provider as 'google' | 'bing'])
        expect(fetch).toHaveBeenLastCalledWith(`/api/${provider}/connect`, {method: 'POST', headers: {Authorization: 'Bearer owner-token'}, retry: 0})
      }
    }
  } finally { scope.stop() }
})
it.each(['google', 'bing'] as const)('discards stale %s status across a same-owner new session', async provider => {
  const {ws, user, fetch, scope} = setup(true)
  try {
    await flush()
    let resolve!: (value: any) => void
    fetch.mockImplementationOnce(() => new Promise(done => {resolve = done}))
    const pending = provider === 'google' ? ws.checkGoogle() : ws.checkBing()
    await flush()
    user.value = null; await flush()
    user.value = {id: 'owner'}; await flush()
    const current = ws[provider].value
    resolve({connected: false, configured: false}); await pending
    expect(ws[provider].value).toBe(current)
    expect(ws[provider].value.connected).toBe(true)
    user.value = null; await flush()
    expect(ws[provider].value.connected).toBe(false)
    expect(provider === 'google' ? ws.connectionReady.value : ws.bingReady.value).toBe(false)
  } finally { scope.stop() }
})
it('refuses an owner action after sign-out', async () => {
  const {ws, user, fetch, scope} = setup(true)
  try {
    await flush()
    user.value = null
    fetch.mockClear()
    await expect(ws.request('/api/google/connection', {method: 'DELETE'})).rejects.toThrow(/session has ended/)
    expect(fetch).not.toHaveBeenCalled()
  } finally { scope.stop() }
})

const authUrls = { google: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque', bing: 'https://www.bing.com/webmasters/oauth/authorize?state=opaque' }
it.each(['google', 'bing'] as const)('uses gated Rust %s Connect without body, cookies or redirect following', async provider => {
  const {ws, fetch, scope} = setup(true, true)
  try {
    await flush(); fetch.mockClear()
    const url = `${base}/auth/${provider}/start?ticket=${'a'.repeat(43)}`
    fetch.mockResolvedValue({url})
    expect(await ws.connectProvider(provider)).toBe(url)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${base}/providers/${provider}/connect`, {method: 'POST', headers: {Authorization: 'Bearer owner-token'}, retry: 0, redirect: 'error', credentials: 'omit'})
    fetch.mockClear()
    await expect(ws.request(`/api/${provider}/connect`, {method: 'POST', body: {redirect: 'https://evil.test'}})).rejects.toThrow(/does not accept a body/)
    expect(fetch).not.toHaveBeenCalled()
    for (const options of [{query: {next: 'evil'}}, {params: {ticket: 'evil'}}, {baseURL: 'https://evil.test'}]) await expect(ws.request(`/api/${provider}/connect`, {method: 'POST', ...options})).rejects.toThrow(/fixed API URL/)
    expect(fetch).not.toHaveBeenCalled()
    expect(() => resolveProviderConnectionPath(`/api/${provider}/connect`, 'GET', true, base, true)).toThrow(/requires POST/)
    for (const suffix of ['?next=evil', '/other', '#fragment']) expect(() => resolveProviderConnectionPath(`/api/${provider}/connect${suffix}`, 'POST', true, base, true)).toThrow(/Unsupported/)
    for (const origin of ['https://user:pass@api.test', 'https://api.test/path', 'https://api.test?next=evil', 'http://api.test']) expect(() => resolveProviderConnectionPath(`/api/${provider}/connect`, 'POST', true, origin, true)).toThrow()
  } finally { scope.stop() }
})
it.each(['google', 'bing'] as const)('validates %s authorization navigation', provider => {
  expect(providerAuthorizationUrl(provider, {url: authUrls[provider]})).toBe(authUrls[provider])
  for (const result of [null, {}, {url: 123}, ...['javascript:alert(1)', '//evil.test', 'https://evil.test', authUrls[provider].replace('.com', '.com.evil.test'), authUrls[provider].replace('https://', 'http://'), authUrls[provider].replace('https://', 'https://user:pass@'), authUrls[provider] + '#fragment', authUrls[provider].replace('/o/oauth2/', '/other/').replace('/webmasters/', '/other/'), authUrls[provider === 'google' ? 'bing' : 'google']].map(url => ({url}))]) {
    expect(() => providerAuthorizationUrl(provider, result)).toThrow(/authorization URL/)
  }
})
it('discards a Connect response after a session change', async () => {
  const {ws, user, fetch, scope} = setup(true, true)
  try {
    await flush()
    let resolve!: (value: unknown) => void
    fetch.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const pending = ws.connectProvider('google'); await flush()
    user.value = null; user.value = {id: 'owner'}
    resolve({url: authUrls.google})
    await expect(pending).rejects.toThrow(/session has ended/)
  } finally { scope.stop() }
})

it.each(['google', 'bing'] as const)('allows only the fixed API %s ticket navigation in static mode', provider => {
  const url = `${base}/auth/${provider}/start?ticket=${'a'.repeat(43)}`
  expect(providerAuthorizationUrl(provider, {url}, base)).toBe(url)
  for (const bad of [authUrls[provider], url.replace(base, 'https://evil.test'), url.replace('/start', '/callback'), url.replace(provider, provider === 'google' ? 'bing' : 'google'), url + '#fragment', url + '&next=evil', url + '&ticket=other', url.replace('a'.repeat(43), ''), url.replace('a'.repeat(43), 'short'), url.replace('a'.repeat(43), '!'.repeat(43))]) expect(() => providerAuthorizationUrl(provider, {url: bad}, base)).toThrow()
})
