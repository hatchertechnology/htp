import type { Ref } from 'vue'
import { resolveWorkspaceOwnerPath, workspaceOwnerBody } from '#shared/utils/workspace-owner-client'
import { PROVIDER_CONNECT_HELD, providerAuthorizationUrl, resolveProviderConnectionPath, type ConnectProvider } from '#shared/utils/provider-connection-client'
import { gatedEvidenceTransport } from '#shared/utils/gated-evidence-client'
import { validDateRange } from '#shared/utils/analytics'
import {
  WORKSPACE_CONTEXT_VERSION, contextStorageKey, parseStoredContext, presetRange, resolveRange, resolveSelection, serializeContext,
  type RangePreset, type StoredContext, type StoredRange,
} from '#shared/utils/workspace-context'
import type { Website } from '../../shared/types/websites'

const PAGE_SIZE = 100
// Bounded site read: the selector never pages past 1,000 websites.
const MAX_PAGES = 10

type WorkspaceStore = { getItem(key: string): string | null; setItem(key: string, value: string): void }

function workspaceStore(): WorkspaceStore | null {
  try {
    const store = (globalThis as { localStorage?: WorkspaceStore }).localStorage
    return store && typeof store.getItem === 'function' && typeof store.setItem === 'function' ? store : null
  } catch { return null }
}

function readStoredContext(ownerId: string): StoredContext | null {
  const store = workspaceStore()
  if (!store) return null
  try { return parseStoredContext(store.getItem(contextStorageKey(ownerId))) } catch { return null }
}

function writeStoredContext(ownerId: string, websiteId: string | null, range: StoredRange | null) {
  const store = workspaceStore()
  if (!store) return
  try { store.setItem(contextStorageKey(ownerId), serializeContext({ version: WORKSPACE_CONTEXT_VERSION, websiteId, range })) } catch { /* storage unavailable: context stays in memory */ }
}

export function useWorkspace() {
  const auth = useAuth()
  const runtime = useRuntimeConfig().public as { staticDashboard?: boolean; apiBaseUrl?: unknown; rolloutProviderConnect?: boolean; rolloutSearchEvidence?: boolean; rolloutLifecycle?: boolean; rolloutRemediation?: boolean }
  const sessionGeneration = useState('workspace:session-generation', () => 0)
  const sites = useState<Website[]>('workspace:sites', () => [])
  const selectedId = useState('workspace:selected', () => '')
  const owner = useState<string | null>('workspace:owner', () => null)
  const loading = useState('workspace:loading', () => false)
  const error = useState('workspace:error', () => '')
  const google = useState('workspace:google', () => ({ connected: false, configured: true, analytics: false, search: false, business: false, reauthorizationRequired: false }))
  const bing = useState('workspace:bing', () => ({ connected: false, configured: true, reauthorizationRequired: false }))
  const bingReady = useState('workspace:bing-ready', () => false)
  const bingError = useState('workspace:bing-error', () => '')
  const connectionReady = useState('workspace:google-ready', () => false)
  const sitesTruncated = useState('workspace:sites-truncated', () => false)
  const contextReady = useState('workspace:context-ready', () => false)
  // The pending site is keyed by owner so a previous owner's choice is never applied.
  const pendingSite = useState<{ owner: string; websiteId: string | null } | null>('workspace:pending-site', () => null)
  const loadState = useState<{ owner: string; generation: number; promise: Promise<void>; again: boolean } | null>('workspace:load-state', () => null)
  const rangePreset = useState<RangePreset | null>('workspace:range-preset', () => null)
  const visibilityInstalled = useState('workspace:visibility-listener', () => false)
  // Report range stays in the same useState keys the reports and fixtures read.
  const start = useState('report:start', () => resolveRange(null, new Date()).start)
  const end = useState('report:end', () => resolveRange(null, new Date()).end)
  const selected = computed(() => sites.value.find(site => site.id === selectedId.value) ?? null)

  const providerConnectAvailable = runtime.staticDashboard !== true || runtime.rolloutProviderConnect === true

  async function request<T>(url: string, options: Record<string, unknown> = {}) {
    const generation = sessionGeneration.value
    const user = auth.user.value?.id
    const token = await auth.accessToken()
    if (!user || !token || generation !== sessionGeneration.value || auth.user.value?.id !== user) throw new Error('Your session has ended. Sign in again.')
    const method = options.method ?? 'GET'
    const evidence = gatedEvidenceTransport(url, options, runtime)
    const ownerPath = resolveWorkspaceOwnerPath(evidence.path, method, runtime.staticDashboard === true, runtime.apiBaseUrl)
    const path = resolveProviderConnectionPath(ownerPath, method, runtime.staticDashboard === true, runtime.apiBaseUrl, runtime.rolloutProviderConnect === true)
    const staticConnect = runtime.staticDashboard === true && /^\/api\/(google|bing)\/connect$/.test(url)
    if (staticConnect && options.body !== undefined) throw new Error('Provider Connect does not accept a body.')
    if (staticConnect && (options.query !== undefined || options.params !== undefined || options.baseURL !== undefined)) throw new Error('Provider Connect uses a fixed API URL.')
    const body = workspaceOwnerBody(url, method, runtime.staticDashboard === true, options.body)
    const requestOptions: Record<string, unknown> = { ...evidence.options, ...('body' in options ? { body } : {}) }
    return $fetch<T>(path, { ...requestOptions, headers: { Authorization: `Bearer ${token}` }, retry: 0, ...(staticConnect ? { redirect: 'error' as const, credentials: 'omit' as const } : {}) })
  }
  async function connectProvider(provider: ConnectProvider) {
    if (provider !== 'google' && provider !== 'bing') throw new Error('Unsupported provider.')
    if (!providerConnectAvailable) throw new Error(PROVIDER_CONNECT_HELD)
    const user = auth.user.value?.id
    const generation = sessionGeneration.value
    const result = await request<unknown>(`/api/${provider}/connect`, { method: 'POST' })
    if (!user || auth.user.value?.id !== user || sessionGeneration.value !== generation) throw new Error('Your session has ended. Sign in again.')
    return providerAuthorizationUrl(provider, result, runtime.staticDashboard === true ? runtime.apiBaseUrl : undefined)
  }

  function currentSession(ownerId: string, generation: number): boolean {
    return auth.user.value?.id === ownerId && sessionGeneration.value === generation && owner.value === ownerId
  }
  function currentRange(): StoredRange | null {
    if (rangePreset.value !== null) return { kind: 'preset', days: rangePreset.value }
    return start.value && end.value ? { kind: 'custom', start: start.value, end: end.value } : null
  }
  // The stored site is written only from a validated selection or, before the
  // list is validated (and after a failed load), from the still-pending stored
  // choice. A range change must never null a persisted website.
  function websiteForStorage(): string | null {
    const current = owner.value
    if (selectedId.value && sites.value.some(site => site.id === selectedId.value)) return selectedId.value
    return current && pendingSite.value?.owner === current ? pendingSite.value.websiteId : null
  }
  function persistRange() {
    const current = owner.value
    if (!current || auth.user.value?.id !== current) return
    writeStoredContext(current, websiteForStorage(), currentRange())
  }

  // A concurrent load() waits for the running pass and queues exactly one more,
  // so `await load()` always resolves with a list that includes everything the
  // server had when it was called (Part D: `await ws.load(); ws.selectWebsite`).
  async function load() {
    const currentOwner = auth.user.value?.id
    if (!currentOwner) return
    const generation = sessionGeneration.value
    const running = loadState.value
    if (running && running.owner === currentOwner && running.generation === generation) {
      running.again = true
      await running.promise.catch(() => {})
      return
    }
    let finish: () => void = () => {}
    const ticket = { owner: currentOwner, generation, promise: new Promise<void>((resolve) => { finish = resolve }), again: false }
    loadState.value = ticket
    try {
      do {
        ticket.again = false
        await runLoad(currentOwner, generation)
      } while (ticket.again && currentSession(currentOwner, generation))
    } finally {
      // `useState` wraps objects in a reactive proxy, so compare the raw promise.
      if (loadState.value?.promise === ticket.promise) loadState.value = null
      finish()
    }
  }
  async function runLoad(currentOwner: string, generation: number) {
    if (!currentSession(currentOwner, generation)) return
    loading.value = true; error.value = ''
    try {
      const collected: Website[] = []
      let truncated = false
      let more = true
      for (let page = 0; page < MAX_PAGES && more; page++) {
        if (!currentSession(currentOwner, generation)) return
        const result = await request<{ items?: Website[]; has_more?: boolean }>(`/api/websites?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`)
        if (!currentSession(currentOwner, generation)) return
        collected.push(...(result.items ?? []))
        more = result.has_more === true
        if (more && page === MAX_PAGES - 1) truncated = true
      }
      sites.value = collected
      sitesTruncated.value = truncated
      const pendingId = pendingSite.value?.owner === currentOwner ? pendingSite.value.websiteId : null
      const selection = resolveSelection(pendingId ?? (selectedId.value || null), collected)
      selectedId.value = selection.id
      // An empty list is stored explicitly as websiteId: null (never ''), so the
      // next load does not keep a stale selection.
      if (selection.overwrite || collected.length === 0) writeStoredContext(currentOwner, selection.id || null, currentRange())
      pendingSite.value = null
      error.value = ''
    } catch (cause) {
      if (!currentSession(currentOwner, generation)) return
      error.value = failureMessage(cause)
    } finally {
      if (currentSession(currentOwner, generation)) { loading.value = false; contextReady.value = true }
    }
  }
  async function checkGoogle() {
    if (!auth.user.value) return
    const user = auth.user.value.id
    const generation = sessionGeneration.value
    try {
      const result = await request<{connected: boolean; configured: boolean; analytics: boolean; search: boolean; business: boolean; reauthorizationRequired: boolean}>('/api/google/connection')
      if (auth.user.value?.id === user && generation === sessionGeneration.value) google.value = result
    } catch { if (auth.user.value?.id === user && generation === sessionGeneration.value) google.value = { connected: false, configured: true, analytics: false, search: false, business: false, reauthorizationRequired: false } }
    finally { if (auth.user.value?.id === user && generation === sessionGeneration.value) connectionReady.value = true }
  }
  async function checkBing() {
    if (!auth.user.value) return
    const user = auth.user.value.id
    const generation = sessionGeneration.value
    try {
      const result = await request<{ connected: boolean; configured: boolean; reauthorizationRequired: boolean }>('/api/bing/connection')
      if (auth.user.value?.id === user && generation === sessionGeneration.value) { bing.value = result; bingError.value = '' }
    } catch (cause) { if (auth.user.value?.id === user && generation === sessionGeneration.value) bingError.value = failureMessage(cause) }
    finally { if (auth.user.value?.id === user && generation === sessionGeneration.value) bingReady.value = true }
  }

  function selectWebsite(id: string): boolean {
    if (typeof id !== 'string' || !sites.value.some(site => site.id === id)) return false
    selectedId.value = id
    return true
  }
  function setPreset(days: RangePreset) {
    if (days !== 7 && days !== 28 && days !== 30 && days !== 90) return
    const resolved = presetRange(days, new Date())
    start.value = resolved.start; end.value = resolved.end; rangePreset.value = days
    persistRange()
  }
  function setCustomRange(from: string, to: string): boolean {
    if (!validDateRange(from, to)) return false
    start.value = from; end.value = to; rangePreset.value = null
    persistRange()
    return true
  }
  // "Include today" makes the persisted range custom everywhere until a preset is picked.
  function includeToday() {
    const today = new Date().toISOString().slice(0, 10)
    if ((Date.parse(today) - Date.parse(start.value)) / 86400_000 >= 366) start.value = new Date(Date.parse(today) - 365 * 86400_000).toISOString().slice(0, 10)
    if (start.value > today) start.value = today
    end.value = today
    rangePreset.value = null
    persistRange()
  }
  const range = {
    start: start as Readonly<Ref<string>>,
    end: end as Readonly<Ref<string>>,
    preset: rangePreset as Readonly<Ref<RangePreset | null>>,
    setPreset,
    setCustomRange,
    includeToday,
  }

  watch(() => [auth.ready.value, auth.user.value?.id] as const, () => {
    const id = auth.user.value?.id ?? null
    if (!auth.ready.value || owner.value === id) return
    sessionGeneration.value++
    owner.value = id; sites.value = []; selectedId.value = ''; error.value = ''; loading.value = false
    sitesTruncated.value = false; contextReady.value = false; pendingSite.value = null; loadState.value = null
    google.value = { connected: false, configured: true, analytics: false, search: false, business: false, reauthorizationRequired: false }; connectionReady.value = false
    bing.value = { connected: false, configured: true, reauthorizationRequired: false }; bingReady.value = false; bingError.value = ''
    // Apply the stored range before any request, so the first report read uses it.
    const stored = id ? readStoredContext(id) : null
    const resolved = resolveRange(stored?.range ?? null, new Date())
    start.value = resolved.start; end.value = resolved.end; rangePreset.value = resolved.preset
    if (id) {
      pendingSite.value = { owner: id, websiteId: stored?.websiteId ?? null }
      void load(); void checkGoogle(); void checkBing()
    }
  }, { immediate: true, flush: 'sync' })
  // Persist the header selection only once the list has validated it.
  watch(selectedId, id => {
    const current = owner.value
    if (!contextReady.value || !current || auth.user.value?.id !== current) return
    if (id && !sites.value.some(site => site.id === id)) return
    writeStoredContext(current, id || null, currentRange())
  })
  // One listener per app: a preset range rolls at 00:00 UTC when the tab returns.
  if (typeof document !== 'undefined' && !visibilityInstalled.value) {
    visibilityInstalled.value = true
    document.addEventListener('visibilitychange', () => {
      const current = owner.value
      if (!current || auth.user.value?.id !== current || rangePreset.value === null) return
      const next = presetRange(rangePreset.value, new Date())
      if (next.start !== start.value || next.end !== end.value) { start.value = next.start; end.value = next.end }
    })
  }
  onMounted(() => { if (auth.user.value && !sites.value.length) void load() })
  return {
    ...auth, sites, selectedId, selected, loading, error, google, connectionReady, bing, bingReady, bingError,
    providerConnectAvailable, connectProvider, request, load, checkGoogle, checkBing,
    sitesTruncated, contextReady, selectWebsite, range,
  }
}
export function failureMessage(cause: unknown) {
  const error = cause as { data?: { error?: string; message?: string; statusMessage?: string }; message?: string }
  return error.data?.error || error.data?.message || error.data?.statusMessage || error.message || 'Something went wrong. Please try again.'
}
export function useReportRange() {
  const { range } = useWorkspace()
  // Shape unchanged for every existing report consumer. AppShell still assigns
  // these two refs directly until Part B switches it to range.setCustomRange.
  return { start: range.start as Ref<string>, end: range.end as Ref<string>, includeToday: range.includeToday }
}
