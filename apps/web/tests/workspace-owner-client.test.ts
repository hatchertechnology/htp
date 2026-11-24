import { afterEach, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, watch } from 'vue'
import { useWorkspace } from '../app/composables/useWorkspace'
import { resolveWorkspaceOwnerPath } from '../shared/utils/workspace-owner-client'
const id = '00000000-0000-0000-0000-000000000001'
const base = 'https://api.example.test'
const repository = `/api/websites/${id}/repository`
afterEach(() => vi.unstubAllGlobals())
it('maps only implemented owner operations and preserves legacy paths', () => {
  for (const [path, method, target] of [
    ['/api/websites?limit=100', 'GET', '/websites?limit=100'],
    ['/api/websites?limit=50&offset=100', 'GET', '/websites?limit=50&offset=100'],
    ...['properties', 'dashboard', 'inspection-history'].map(action => [`/api/websites/${id}/search/${action}`, 'POST', `/websites/${id}/search/${action}`]),
    [repository, 'GET', `/websites/${id}/repository`],
    [repository, 'PUT', `/websites/${id}/repository`],
    [`${repository}/history`, 'GET', `/websites/${id}/repository`],
    [`${repository}/issues`, 'GET', `/websites/${id}/repository/issues`],
  ]) {
    expect(resolveWorkspaceOwnerPath(path!, method, true, `${base}/`)).toBe(`${base}${target}`)
    expect(resolveWorkspaceOwnerPath(path!, method, false, undefined)).toBe(path)
    expect(() => resolveWorkspaceOwnerPath(path!, method, true, 'https://api.test/path')).toThrow()
  }
  for (const [path, method] of [
    ...['inspect', 'dataset', 'crawl-evidence', 'unknown', 'dashboard/', 'dashboard/extra', 'dashboard?x=1'].map(action => [`/api/websites/${id}/search/${action}`, 'POST']),
    ...['GET', 'PUT', 'DELETE', 'post', undefined].map(method => [`/api/websites/${id}/search/dashboard`, method]),
    ['/api/websites/invalid/search/dashboard', 'POST'],
    [repository, 'POST'], [`${repository}/issues`, 'PUT'], [`${repository}/history`, 'PUT'],
    [`${repository}/other`, 'GET'], [`${repository}/issues/extra`, 'GET'],
    ['/api/websites/invalid/repository', 'GET'], ['/api/websites?target=https://evil.test', 'GET'],
    ['https://evil.test/api/websites', 'GET'], ['/api/websites/../repository', 'GET'],
    ['/api/websites', 'DELETE'], ['/api/google/connect', 'GET'], ['/api/bing/callback', 'GET'],
  ]) expect(resolveWorkspaceOwnerPath(path!, method, true, undefined)).toBe(path)
})
it.each([true, false])('workspace forwards owner payloads, query, signal and response (static=%s)', async staticDashboard => {
  const states = new Map(), user = ref<{id: string} | null>({id: 'owner'})
  const payload = {items: [{id, fqdn: 'example.test'}], has_more: false}
  const fetch = vi.fn().mockResolvedValue(payload)
  vi.stubGlobal('useAuth', () => ({user, ready: ref(true), accessToken: async () => 'owner-token'}))
  vi.stubGlobal('useRuntimeConfig', () => ({public: {staticDashboard, apiBaseUrl: base}}))
  vi.stubGlobal('useState', (key: string, init: () => unknown) => { if (!states.has(key)) states.set(key, ref(init())); return states.get(key) })
  Object.entries({computed, watch, onMounted: vi.fn(), $fetch: fetch}).forEach(([key, value]) => vi.stubGlobal(key, value))
  const scope = effectScope(), ws = scope.run(() => useWorkspace())!
  try {
    await nextTick(); await Promise.resolve(); await Promise.resolve()
    expect(fetch).toHaveBeenCalledWith(staticDashboard ? `${base}/websites?limit=100` : '/api/websites?limit=100', {headers: {Authorization: 'Bearer owner-token'}, retry: 0})
    await vi.waitFor(() => expect(ws.sites.value).toEqual(payload.items))
    expect(ws.selectedId.value).toBe(id)
    const signal = new AbortController().signal
    for (const [path, options] of [
      ...['properties', 'dashboard', 'inspection-history'].map(action => [`/api/websites/${id}/search/${action}`, {method: 'POST', body: {site_url: 'sc-domain:example.test', start_date: '2026-10-01', end_date: '2026-10-30', url: 'https://example.test/', before_id: 12}, signal}]),
      [repository, {query: {start_date: '2026-10-01', end_date: '2026-10-30', before_id: 12}, signal}],
      [`${repository}/issues`, {query: {state: 'closed', page: 2}, signal}],
      ...[true, false].map(enabled => [repository, {method: 'PUT', body: {repository_url: enabled ? 'https://github.com/example/site' : null, branch: null, enabled}}]),
    ] as [string, Record<string, unknown>][]) {
      expect(await ws.request(path, options)).toBe(payload)
      expect(fetch).toHaveBeenLastCalledWith(resolveWorkspaceOwnerPath(path, options.method ?? 'GET', staticDashboard, base), {...options, headers: {Authorization: 'Bearer owner-token'}, retry: 0})
    }
    user.value = null; fetch.mockClear()
    await expect(ws.request(repository, {method: 'PUT'})).rejects.toThrow(/session has ended/)
    expect(fetch).not.toHaveBeenCalled()
  } finally { scope.stop() }
})
