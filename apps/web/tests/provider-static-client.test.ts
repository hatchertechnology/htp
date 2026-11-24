import { afterEach, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, watch } from 'vue'
import { useWorkspace } from '../app/composables/useWorkspace'
import { resolveProviderConnectionPath } from '../shared/utils/provider-connection-client'
const base = 'https://api.example.test'
afterEach(() => vi.unstubAllGlobals())
it.each(['google', 'bing'])('maps only %s connection GET/DELETE', provider => {
  const path = `/api/${provider}/connection`
  for (const method of ['GET', 'DELETE']) {
    expect(resolveProviderConnectionPath(path, method, true, `${base}/`)).toBe(`${base}/providers/${provider}/connection`)
    expect(resolveProviderConnectionPath(path, method, false, undefined)).toBe(path)
  }
  for (const other of [`/api/${provider}/connect`, `/api/${provider}/callback`, `${path}/other`]) expect(resolveProviderConnectionPath(other, 'GET', true, undefined)).toBe(other)
  expect(resolveProviderConnectionPath(path, 'POST', true, undefined)).toBe(path)
  expect(() => resolveProviderConnectionPath(path, 'GET', true, undefined)).toThrow(/API base URL/)
  expect(() => resolveProviderConnectionPath(path, 'GET', true, 'https://user:pass@example.test')).toThrow()
})
function setup(staticDashboard: boolean) {
  const states = new Map<string, any>(), user = ref<{id: string} | null>({id: 'owner'})
  const fetch = vi.fn<(url: string, options: any) => Promise<any>>(async () => ({items: [], connected: true, configured: true}))
  vi.stubGlobal('useAuth', () => ({user, ready: ref(true), accessToken: async () => 'owner-token'}))
  vi.stubGlobal('useRuntimeConfig', () => ({public: {staticDashboard, apiBaseUrl: base}}))
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
      await ws.request(`/api/${provider}/connect`, {method: 'POST'})
      expect(fetch).toHaveBeenLastCalledWith(`/api/${provider}/connect`, {method: 'POST', headers: {Authorization: 'Bearer owner-token'}, retry: 0})
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
