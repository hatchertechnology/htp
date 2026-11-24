import { afterEach, expect, it, vi } from 'vitest'
import { computed, effectScope, ref, watch } from 'vue'
import { useWorkspace } from '../app/composables/useWorkspace'
import { gatedEvidenceTransport } from '../shared/utils/gated-evidence-client'
const id = '00000000-0000-0000-0000-000000000001'
const base = 'https://api.example.test'
const cases = [
  ['search/dataset', 'POST', 'rolloutSearchEvidence'],
  ['search/crawl-evidence', 'POST', 'rolloutSearchEvidence'],
  ['seo/audits/lifecycle', 'GET', 'rolloutLifecycle'],
  ['seo/audits/url-lifecycle', 'GET', 'rolloutLifecycle'],
  [`seo/audits/${id}/work`, 'GET', 'rolloutRemediation'],
  [`seo/audits/${id}/work`, 'POST', 'rolloutRemediation'],
  [`seo/work/${id}/attempts`, 'POST', 'rolloutRemediation'],
]
afterEach(() => vi.unstubAllGlobals())
it.each(cases)('workspace transports %s %s only with its UI flag', async (resource, method, flag) => {
  const path = `/api/websites/${id}/${resource}`, states = new Map()
  const runtime: Record<string, unknown> = {staticDashboard: true, apiBaseUrl: base}
  const payload = {items: [], has_more: false}, fetch = vi.fn().mockResolvedValue(payload)
  vi.stubGlobal('useAuth', () => ({user: ref({id: 'owner'}), ready: ref(false), accessToken: async () => 'synthetic'}))
  vi.stubGlobal('useRuntimeConfig', () => ({public: runtime}))
  vi.stubGlobal('useState', (key: string, init: () => unknown) => { if (!states.has(key)) states.set(key, ref(init())); return states.get(key) })
  Object.entries({computed, watch, onMounted: vi.fn(), $fetch: fetch}).forEach(([key, value]) => vi.stubGlobal(key, value))
  const scope = effectScope(), ws = scope.run(() => useWorkspace())!
  const body = {finding_index: 0, work: {status: 'open'}}, signal = new AbortController().signal
  const query = {entity_id: 'url:a', rule: 'title', finding_index: 0, before: 'date', before_id: id, extra: 'discard'}
  try {
    for (const value of [undefined, false, 'true']) {
      runtime[flag!] = value
      await expect(ws.request(path, {method, body})).rejects.toMatchObject({statusCode: 503})
      expect(fetch).not.toHaveBeenCalled()
    }
    runtime[flag!] = true
    expect(await ws.request(path, {method, body, query, signal})).toBe(payload)
    const options = fetch.mock.calls[0]![1]
    expect(fetch.mock.calls[0]![0]).toBe(`${base}${path.slice(4)}`)
    expect(options).toMatchObject({method, body, signal, redirect: 'error', retry: 0, headers: {Authorization: 'Bearer synthetic'}, timeout: resource!.startsWith('search') ? 35000 : 30000})
    if (method === 'GET') {
      expect(options.query).not.toHaveProperty('extra')
      if (resource!.includes('lifecycle')) expect(options.query.limit).toBe(50)
      else expect(options.query).toEqual({finding_index: 0, before: 'date', before_id: id})
    } else expect(options.query).toBeUndefined()
    const failure = {statusCode: 503, data: {error: 'This feature is not available yet.'}}
    fetch.mockRejectedValueOnce(failure)
    await expect(ws.request(path, {method, body})).rejects.toBe(failure)
    runtime.staticDashboard = false; runtime[flag!] = false
    fetch.mockResolvedValue(payload)
    await ws.request(path, {method, body, query})
    expect(fetch).toHaveBeenLastCalledWith(path, {method, body, query, headers: {Authorization: 'Bearer synthetic'}, retry: 0})
  } finally { scope.stop() }
})
it.each(cases)('closed routing for %s', (resource, method, flag) => {
  const path = `/api/websites/${id}/${resource}`, runtime = {staticDashboard: true, apiBaseUrl: base, [flag!]: true}
  for (const bad of [path + '/', path + '/extra', path + '\n', path + '?x=1', path.replace(id, 'invalid'), path.replace(id, id.replaceAll('-', '')), 'https://evil.test' + path]) {
    expect(gatedEvidenceTransport(bad, {method}, runtime).path).toBe(bad)
  }
  expect(() => gatedEvidenceTransport(path, {method: 'DELETE'}, runtime)).toThrow(/method/)
  expect(() => gatedEvidenceTransport(path, {method}, {...runtime, apiBaseUrl: 'https://api.test/path'})).toThrow()
})
