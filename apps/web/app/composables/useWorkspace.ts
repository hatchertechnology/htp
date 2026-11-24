import { resolveWorkspaceOwnerPath, workspaceOwnerBody } from '#shared/utils/workspace-owner-client'
import { resolveProviderConnectionPath } from '#shared/utils/provider-connection-client'
import type { Website } from '../../shared/types/websites'

export function useWorkspace() {
  const auth = useAuth()
  const runtime = useRuntimeConfig().public as { staticDashboard?: boolean; apiBaseUrl?: unknown }
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
  const selected = computed(() => sites.value.find(site => site.id === selectedId.value) ?? null)

  async function request<T>(url: string, options: Record<string, unknown> = {}) {
    const generation = sessionGeneration.value
    const user = auth.user.value?.id
    const token = await auth.accessToken()
    if (!user || !token || generation !== sessionGeneration.value || auth.user.value?.id !== user) throw new Error('Your session has ended. Sign in again.')
    const method = options.method ?? 'GET'
    const ownerPath = resolveWorkspaceOwnerPath(url, method, runtime.staticDashboard === true, runtime.apiBaseUrl)
    const path = resolveProviderConnectionPath(ownerPath, method, runtime.staticDashboard === true, runtime.apiBaseUrl)
    const body = workspaceOwnerBody(url, method, runtime.staticDashboard === true, options.body)
    const requestOptions: Record<string, unknown> = { ...options, ...('body' in options ? { body } : {}) }
    return $fetch<T>(path, { ...requestOptions, headers: { Authorization: `Bearer ${token}` }, retry: 0 })
  }
  async function load() {
    if (!auth.user.value || loading.value) return
    const user = auth.user.value.id
    loading.value = true; error.value = ''
    try {
      const result = await request<{ items: Website[]; has_more: boolean }>('/api/websites?limit=100')
      if (auth.user.value?.id !== user) return
      sites.value = result.items
      if (!sites.value.some(site => site.id === selectedId.value)) selectedId.value = sites.value[0]?.id ?? ''
    } catch (cause) { if (auth.user.value?.id === user) error.value = failureMessage(cause) }
    finally { if (auth.user.value?.id === user) loading.value = false }
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
  watch(() => [auth.ready.value, auth.user.value?.id] as const, () => {
    const id = auth.user.value?.id ?? null
    if (!auth.ready.value || owner.value === id) return
    sessionGeneration.value++
    owner.value = id; sites.value = []; selectedId.value = ''; error.value = ''; loading.value = false
    google.value = { connected: false, configured: true, analytics: false, search: false, business: false, reauthorizationRequired: false }; connectionReady.value = false
    bing.value = { connected: false, configured: true, reauthorizationRequired: false }; bingReady.value = false; bingError.value = ''
    if (id) { void load(); void checkGoogle(); void checkBing() }
  }, { immediate: true, flush: 'sync' })
  onMounted(() => { if (auth.user.value && !sites.value.length) void load() })
  return { ...auth, sites, selectedId, selected, loading, error, google, connectionReady, bing, bingReady, bingError, request, load, checkGoogle, checkBing }
}
export function failureMessage(cause: unknown) {
  const error = cause as { data?: { error?: string; message?: string; statusMessage?: string }; message?: string }
  return error.data?.error || error.data?.message || error.data?.statusMessage || error.message || 'Something went wrong. Please try again.'
}
export function useReportRange() {
  const now = new Date()
  const start = useState('report:start', () => new Date(now.getTime() - 28 * 86400_000).toISOString().slice(0, 10))
  const end = useState('report:end', () => new Date(now.getTime() - 86400_000).toISOString().slice(0, 10))
  function includeToday() {
    const today = new Date().toISOString().slice(0, 10)
    if ((Date.parse(today) - Date.parse(start.value)) / 86400_000 >= 366) start.value = new Date(Date.parse(today) - 365 * 86400_000).toISOString().slice(0, 10)
    if (start.value > today) start.value = today
    end.value = today
  }
  return { start, end, includeToday }
}
