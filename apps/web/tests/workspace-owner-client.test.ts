import { afterEach, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, watch } from 'vue'
import { useWorkspace } from '../app/composables/useWorkspace'
import { resolveWorkspaceOwnerPath } from '../shared/utils/workspace-owner-client'
const id = '00000000-0000-0000-0000-000000000001'
const base = 'https://api.example.test'
const reports = ['analytics/dashboard', 'bing/dashboard', 'insights/report', 'insights/history', 'business/location']
const repository = `/api/websites/${id}/repository`
afterEach(() => vi.unstubAllGlobals())
it('maps only implemented owner operations and preserves legacy paths', () => {
  for (const [path, method, target] of [
    ...reports.map(resource => [`/api/websites/${id}/${resource}`, resource === 'business/location' ? 'PUT' : 'POST', `/websites/${id}/${resource}`]),
    ['/api/websites?limit=100', 'GET', '/websites?limit=100'],
    ['/api/websites?limit=50&offset=100', 'GET', '/websites?limit=50&offset=100'],
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
    ...reports.flatMap(resource => ['GET', 'DELETE', resource === 'business/location' ? 'POST' : 'PUT'].map(method => [`/api/websites/${id}/${resource}`, method])),
    ...reports.flatMap(resource => [`/api/websites/invalid/${resource}`, `/api/websites/${id}/${resource}/`, `/api/websites/${id}/${resource}/extra`, `/api/websites/${id}/${resource}?x=1`].map(path => [path, resource === 'business/location' ? 'PUT' : 'POST'])),
    [`/api/websites/${id}/analytics/property`, 'PUT'],
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
      ...reports.map(resource => [`/api/websites/${id}/${resource}`, {method: resource === 'business/location' ? 'PUT' : 'POST', body: resource === 'business/location' ? {location_id: 'locations/123', linked: false} : {start_date: '2026-10-01', end_date: '2026-10-30', ...(resource.startsWith('bing/') ? {} : {property_id: '123'}), ...(resource.startsWith('insights/') ? {kind: 'conversions', before_id: 12} : {})}, signal}]),
      [repository, {query: {start_date: '2026-10-01', end_date: '2026-10-30', before_id: 12}, signal}],
      [`${repository}/issues`, {query: {state: 'closed', page: 2}, signal}],
      ...[true, false].map(enabled => [repository, {method: 'PUT', body: {repository_url: enabled ? 'https://github.com/example/site' : null, branch: null, enabled}}]),
    ] as [string, Record<string, unknown>][]) {
      expect(await ws.request(path, options)).toBe(payload)
      expect(fetch).toHaveBeenLastCalledWith(resolveWorkspaceOwnerPath(path, options.method ?? 'GET', staticDashboard, base), {...options, headers: {Authorization: 'Bearer owner-token'}, retry: 0})
    }
    const failure = Object.assign(new Error('No access'), {statusCode: 403, data: {error: 'No access'}})
    fetch.mockRejectedValueOnce(failure)
    await expect(ws.request(`/api/websites/${id}/insights/report`, {method: 'POST', body: {}})).rejects.toBe(failure)
    user.value = null; fetch.mockClear()
    await expect(ws.request(repository, {method: 'PUT'})).rejects.toThrow(/session has ended/)
    expect(fetch).not.toHaveBeenCalled()
  } finally { scope.stop() }
})
