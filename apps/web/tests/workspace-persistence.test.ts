import { afterEach, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, ref, watch } from 'vue'
import { useReportRange, useWorkspace } from '../app/composables/useWorkspace'
import { contextStorageKey, parseStoredContext, serializeContext } from '../shared/utils/workspace-context'

const uuid = (series: number, n: number) => `${series}0000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`
const OWNER_A = uuid(1, 1)
const OWNER_B = uuid(2, 1)
const A1 = uuid(1, 2)
const A2 = uuid(1, 3)
const A3 = uuid(1, 4)
const B1 = uuid(2, 2)
const STALE = uuid(9, 9)

type Site = { id: string; fqdn: string }
type Page = { items: Site[]; has_more: boolean }
type Store = ReturnType<typeof memoryStorage>

function site(id: string): Site {
  return { id, fqdn: `${id.slice(0, 8)}.test` }
}

function memoryStorage(initial: Record<string, string> = {}, options: { throwOnRead?: boolean; throwOnWrite?: boolean } = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem(key: string) {
      if (options.throwOnRead) throw new Error('storage denied')
      return data.has(key) ? data.get(key)! : null
    },
    setItem(key: string, value: string) {
      if (options.throwOnWrite) throw new Error('storage denied')
      data.set(key, value)
    },
    removeItem(key: string) { data.delete(key) },
  }
}

function stored(websiteId: string | null, range: unknown = { kind: 'preset', days: 30 }): string {
  return serializeContext({ version: 1, websiteId, range: range as never })
}

async function settle(rounds = 20) {
  for (let index = 0; index < rounds; index++) { await Promise.resolve(); await nextTick() }
}

function harness(options: {
  user?: string | null
  store?: Store
  pages?: (url: string, owner: string | null) => Page | Promise<Page>
}) {
  const states = new Map<string, { value: unknown }>()
  const user = ref<{ id: string } | null>(options.user ? { id: options.user } : null)
  const ready = ref(true)
  const calls: { url: string; options: Record<string, unknown> }[] = []
  const store = options.store ?? memoryStorage()
  const listeners: Array<() => void> = []
  const documentStub = { addEventListener: (type: string, listener: () => void) => { if (type === 'visibilitychange') listeners.push(listener) } }
  const pages = options.pages ?? (() => ({ items: [site(A1), site(A2)], has_more: false }))
  vi.stubGlobal('localStorage', store)
  vi.stubGlobal('document', documentStub)
  vi.stubGlobal('useAuth', () => ({ user, ready, accessToken: async () => user.value ? 'owner-token' : null, resolveSession: async () => user.value, signOut: async () => ({ error: null }) }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { staticDashboard: false } }))
  vi.stubGlobal('useState', (key: string, initial: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(initial()))
    return states.get(key)
  })
  vi.stubGlobal('$fetch', vi.fn(async (url: string, requestOptions: Record<string, unknown>) => {
    calls.push({ url, options: requestOptions })
    if (url.includes('/api/websites')) return pages(url, user.value?.id ?? null)
    if (url.includes('/connection')) return { connected: false, configured: true }
    return {}
  }))
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('onMounted', vi.fn())
  const scope = effectScope()
  const ws = scope.run(() => useWorkspace())!
  const websiteCalls = () => calls.filter(call => call.url.includes('/api/websites'))
  const contextOf = (owner: string) => {
    const raw = store.data.get(contextStorageKey(owner))
    return raw === undefined ? null : parseStoredContext(raw)
  }
  return { ws, user, store, calls, websiteCalls, contextOf, scope, listeners }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('persists the selected website per owner and never inherits another owner choice', async () => {
  const store = memoryStorage()
  const sitesA = [site(A1), site(A2)]
  const sitesB = [site(B1)]
  const h = harness({ user: OWNER_A, store, pages: (_url, owner) => ({ items: owner === OWNER_B ? sitesB : sitesA, has_more: false }) })
  await settle()

  expect(h.ws.contextReady.value).toBe(true)
  expect(h.ws.loading.value).toBe(false)
  expect(h.ws.selectedId.value).toBe(A1)
  expect(h.contextOf(OWNER_A)?.websiteId).toBe(A1)
  expect(h.contextOf(OWNER_A)?.range).toEqual({ kind: 'preset', days: 30 })

  expect(h.ws.selectWebsite(A2)).toBe(true)
  expect(h.ws.selectWebsite('not-a-site')).toBe(false)
  await settle()
  expect(h.ws.selectedId.value).toBe(A2)
  expect(h.contextOf(OWNER_A)?.websiteId).toBe(A2)

  h.user.value = { id: OWNER_B }
  await settle()
  expect(h.ws.selectedId.value).toBe(B1)
  expect(h.ws.sites.value.map(item => item.id)).toEqual([B1])
  expect(h.contextOf(OWNER_B)?.websiteId).toBe(B1)
  expect(h.contextOf(OWNER_A)?.websiteId).toBe(A2)

  h.user.value = { id: OWNER_A }
  await settle()
  expect(h.ws.selectedId.value).toBe(A2)
  expect(h.ws.sites.value.map(item => item.id)).toEqual([A1, A2])
  h.scope.stop()
})

it('falls back to the first website when the stored one is inaccessible and never requests it', async () => {
  const store = memoryStorage({ [contextStorageKey(OWNER_A)]: stored(STALE) })
  const h = harness({ user: OWNER_A, store, pages: () => ({ items: [site(A1), site(A2)], has_more: false }) })
  await settle()

  expect(h.ws.selectedId.value).toBe(A1)
  expect(h.contextOf(OWNER_A)?.websiteId).toBe(A1)
  h.websiteCalls().forEach(call => expect(call.url).not.toContain(STALE))
  h.calls.forEach(call => expect(call.url).not.toContain(STALE))
  h.scope.stop()
})

it('recomputes a preset range on load and keeps a custom range fixed', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-25T03:00:00Z'))
  const store = memoryStorage()
  const sites = () => ({ items: [site(A1), site(A2)], has_more: false })
  const first = harness({ user: OWNER_A, store, pages: sites })
  await settle()
  expect(first.ws.range.preset.value).toBe(30)
  expect([first.ws.range.start.value, first.ws.range.end.value]).toEqual(['2026-10-26', '2026-11-24'])

  first.ws.range.setPreset(30)
  await settle()
  expect(first.contextOf(OWNER_A)?.range).toEqual({ kind: 'preset', days: 30 })
  first.ws.range.setPreset(7)
  await settle()
  expect([first.ws.range.start.value, first.ws.range.end.value]).toEqual(['2026-11-18', '2026-11-24'])
  first.scope.stop()

  vi.setSystemTime(new Date('2026-11-26T03:00:00Z'))
  const second = harness({ user: OWNER_A, store, pages: sites })
  await settle()
  expect([second.ws.range.start.value, second.ws.range.end.value]).toEqual(['2026-11-19', '2026-11-25'])

  expect(second.ws.range.setCustomRange('2026-10-01', '2026-10-10')).toBe(true)
  expect(second.ws.range.setCustomRange('2026-10-10', '2026-10-01')).toBe(false)
  await settle()
  expect(second.contextOf(OWNER_A)?.range).toEqual({ kind: 'custom', start: '2026-10-01', end: '2026-10-10' })
  second.scope.stop()

  vi.setSystemTime(new Date('2026-12-01T03:00:00Z'))
  const third = harness({ user: OWNER_A, store, pages: sites })
  await settle()
  expect([third.ws.range.start.value, third.ws.range.end.value]).toEqual(['2026-10-01', '2026-10-10'])
  expect(third.ws.range.preset.value).toBeNull()

  third.ws.range.includeToday()
  await settle()
  expect([third.ws.range.start.value, third.ws.range.end.value]).toEqual(['2026-10-01', '2026-12-01'])
  expect(third.ws.range.preset.value).toBeNull()
  expect(third.contextOf(OWNER_A)?.range).toEqual({ kind: 'custom', start: '2026-10-01', end: '2026-12-01' })
  third.scope.stop()
})

it('keeps working in memory when storage is unavailable', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-25T03:00:00Z'))
  const h = harness({ user: OWNER_A, store: memoryStorage({}, { throwOnRead: true, throwOnWrite: true }), pages: () => ({ items: [site(A1), site(A2)], has_more: false }) })
  await settle()
  expect(h.ws.selectedId.value).toBe(A1)
  expect(h.ws.contextReady.value).toBe(true)
  expect(h.ws.error.value).toBe('')
  expect(() => h.ws.range.setPreset(7)).not.toThrow()
  expect([h.ws.range.start.value, h.ws.range.end.value]).toEqual(['2026-11-18', '2026-11-24'])
  h.scope.stop()
})

it('follows three pages of websites and stops at the 1,000-site bound', async () => {
  const paged = harness({
    user: OWNER_A,
    pages: url => {
      const offset = Number(new URL(url, 'http://local').searchParams.get('offset'))
      return { items: [site(uuid(3, 10 + offset / 100))], has_more: offset < 200 }
    },
  })
  await settle()
  expect(paged.websiteCalls().map(call => new URL(call.url, 'http://local').searchParams.get('offset'))).toEqual(['0', '100', '200'])
  expect(paged.ws.sites.value).toHaveLength(3)
  expect(paged.ws.sitesTruncated.value).toBe(false)
  paged.scope.stop()

  const bounded = harness({ user: OWNER_A, pages: () => ({ items: [site(A1)], has_more: true }) })
  await settle()
  expect(bounded.websiteCalls()).toHaveLength(10)
  expect(bounded.websiteCalls().map(call => new URL(call.url, 'http://local').searchParams.get('offset'))).toEqual(['0', '100', '200', '300', '400', '500', '600', '700', '800', '900'])
  expect(bounded.ws.sitesTruncated.value).toBe(true)
  bounded.scope.stop()
})

it('falls back to the first website and overwrites storage when the selected one is deleted', async () => {
  let list = [site(A1), site(A2)]
  const h = harness({ user: OWNER_A, pages: () => ({ items: list, has_more: false }) })
  await settle()
  h.ws.selectWebsite(A2)
  await settle()
  expect(h.contextOf(OWNER_A)?.websiteId).toBe(A2)

  list = [site(A1)]
  await h.ws.load()
  await settle()
  expect(h.ws.selectedId.value).toBe(A1)
  expect(h.contextOf(OWNER_A)?.websiteId).toBe(A1)
  h.scope.stop()
})

it('stores null for an empty website list', async () => {
  const h = harness({ user: OWNER_A, pages: () => ({ items: [], has_more: false }) })
  await settle()
  expect(h.ws.selectedId.value).toBe('')
  expect(h.contextOf(OWNER_A)?.websiteId).toBeNull()
  expect(h.ws.contextReady.value).toBe(true)
  h.scope.stop()
})

it('marks the context ready with an error after a failed load so the header can retry', async () => {
  let fail = true
  const h = harness({
    user: OWNER_A,
    pages: () => {
      if (fail) throw Object.assign(new Error('Request failed'), { data: { error: 'Could not load websites.' } })
      return { items: [site(A1)], has_more: false }
    },
  })
  await settle()
  expect(h.ws.contextReady.value).toBe(true)
  expect(h.ws.error.value).toBe('Could not load websites.')
  expect(h.ws.loading.value).toBe(false)

  fail = false
  await h.ws.load()
  await settle()
  expect(h.ws.error.value).toBe('')
  expect(h.ws.selectedId.value).toBe(A1)
  expect(h.contextOf(OWNER_A)?.websiteId).toBe(A1)
  h.scope.stop()
})

it('rolls a preset range at the UTC day boundary on visibilitychange, once per app', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-25T03:00:00Z'))
  const h = harness({ user: OWNER_A })
  await settle()
  expect(h.listeners).toHaveLength(1)
  h.scope.run(() => useWorkspace())
  h.scope.run(() => useReportRange())
  expect(h.listeners).toHaveLength(1)

  vi.setSystemTime(new Date('2026-11-26T03:00:00Z'))
  h.listeners.forEach(listener => listener())
  expect([h.ws.range.start.value, h.ws.range.end.value]).toEqual(['2026-10-27', '2026-11-25'])
  expect(h.ws.range.preset.value).toBe(30)

  h.ws.range.setCustomRange('2026-10-01', '2026-10-10')
  vi.setSystemTime(new Date('2026-12-05T03:00:00Z'))
  h.listeners.forEach(listener => listener())
  expect([h.ws.range.start.value, h.ws.range.end.value]).toEqual(['2026-10-01', '2026-10-10'])
  h.scope.stop()
})

it('keeps useReportRange writable for existing consumers and shares the range refs', async () => {
  const h = harness({ user: OWNER_A })
  await settle()
  const range = h.scope.run(() => useReportRange())!
  expect(range.start).toBe(h.ws.range.start)
  expect(range.end).toBe(h.ws.range.end)
  range.start.value = '2026-01-01'
  expect(h.ws.range.start.value).toBe('2026-01-01')
  range.includeToday()
  expect(range.end.value).toBe(new Date().toISOString().slice(0, 10))
  h.scope.stop()
})

it('ignores a paged load that finishes after the owner switched', async () => {
  let releaseA: () => void = () => {}
  const heldA = new Promise<void>(resolve => { releaseA = resolve })
  const store = memoryStorage({ [contextStorageKey(OWNER_B)]: stored(B1, { kind: 'preset', days: 30 }) })
  const h = harness({
    user: OWNER_A,
    store,
    pages: async (url, owner) => {
      const offset = Number(new URL(url, 'http://local').searchParams.get('offset'))
      if (owner === OWNER_A) {
        if (offset === 0) return { items: [site(A1), site(A2)], has_more: true }
        await heldA
        return { items: [site(A3)], has_more: false }
      }
      if (owner === OWNER_B) return { items: [site(B1)], has_more: false }
      return { items: [], has_more: false }
    },
  })
  await settle()
  expect(h.ws.sites.value).toHaveLength(0)
  expect(h.websiteCalls()).toHaveLength(2)

  h.user.value = { id: OWNER_B }
  await settle()
  expect(h.ws.sites.value.map(item => item.id)).toEqual([B1])
  expect(h.ws.selectedId.value).toBe(B1)
  expect(h.ws.contextReady.value).toBe(true)
  const callsAfterSwitch = h.calls.length

  releaseA()
  await settle()
  expect(h.ws.sites.value.map(item => item.id)).toEqual([B1])
  expect(h.ws.selectedId.value).toBe(B1)
  expect(h.contextOf(OWNER_A)).toBeNull()
  expect(h.contextOf(OWNER_B)?.websiteId).toBe(B1)
  expect(h.calls).toHaveLength(callsAfterSwitch)
  h.websiteCalls().forEach(call => expect(call.url).not.toContain(A1))
  h.scope.stop()
})
