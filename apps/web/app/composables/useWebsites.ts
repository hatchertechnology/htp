import type { Website, WebsitePage } from '../../shared/types/websites'
import { resolveWebsitePath } from '#shared/utils/websites-client'

// Mutation helper for the selected website. The list itself lives in
// `useWorkspace()` (bounded paging, persisted selection), so this composable no
// longer loads on mount: the Websites page reads `ws.sites` and `ws.selected`.
export function useWebsites() {
  const auth = useAuth()
  // Optional local typing: the build lane owns the declaration and default of these settings.
  const runtime = useRuntimeConfig().public as { apiBaseUrl?: unknown; staticDashboard?: boolean }
  const items = ref<Website[]>([])
  const hasMore = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  let generation = 0
  let controller: AbortController | null = null

  async function request<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: { fqdn: string }, signal?: AbortSignal) {
    const token = await auth.accessToken()
    if (!token) throw new Error('Your session has ended. Sign in again.')
    const url = resolveWebsitePath(path, runtime.staticDashboard === true, runtime.apiBaseUrl)
    return $fetch<T>(url, { method, body, signal, headers: { Authorization: `Bearer ${token}` }, retry: 0 })
  }

  function message(cause: unknown) {
    const failure = cause as { data?: { error?: string; message?: string }; message?: string }
    return failure.data?.error || failure.data?.message || 'Could not save your changes. Please try again.'
  }

  function reset() {
    generation++
    controller?.abort()
    items.value = []
    hasMore.value = false
    error.value = ''
    loading.value = false
    saving.value = false
  }

  // Kept for compatibility; the Websites page refreshes through `useWorkspace()`.
  async function load(more = false) {
    if (!auth.user.value || loading.value) return
    const current = ++generation
    controller?.abort()
    controller = new AbortController()
    loading.value = true
    error.value = ''
    try {
      const page = await request<WebsitePage>(`/api/websites?limit=50&offset=${more ? items.value.length : 0}`, 'GET', undefined, controller.signal)
      if (current !== generation) return
      items.value = more ? [...items.value, ...page.items] : page.items
      hasMore.value = page.has_more
    } catch (cause) {
      if (current === generation) error.value = message(cause)
    } finally { if (current === generation) loading.value = false }
  }

  // Returns the created/updated website, or the deleted record for DELETE.
  // `null` means the mutation failed; `error` carries the message.
  async function mutate(method: 'POST' | 'PATCH' | 'DELETE', id?: string, fqdn?: string): Promise<Website | null> {
    if (saving.value || !auth.user.value) return null
    const owner = auth.user.value.id
    const current = ++generation
    controller?.abort()
    controller = new AbortController()
    saving.value = true
    loading.value = false
    error.value = ''
    try {
      // DELETE bodies are not part of the owner contract; `fqdn` is only the
      // deleted record's display value for the caller's selection fallback.
      const body = method === 'DELETE' || fqdn === undefined ? undefined : { fqdn }
      const result = await request<Website | null>(`/api/websites${id ? `/${id}` : ''}`, method, body, controller.signal)
      if (current !== generation || auth.user.value?.id !== owner) return null
      if (method === 'DELETE') return id ? { id, fqdn: fqdn ?? '' } : null
      if (!result || typeof result.id !== 'string' || typeof result.fqdn !== 'string') return null
      return { id: result.id, fqdn: result.fqdn, ga4_property_id: result.ga4_property_id ?? null }
    } catch (cause) {
      if (auth.user.value?.id === owner) error.value = message(cause)
      return null
    } finally { if (auth.user.value?.id === owner) saving.value = false }
  }

  onBeforeUnmount(reset)
  return { items, hasMore, loading, saving, error, load, mutate }
}
