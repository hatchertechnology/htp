import type { Website, WebsitePage } from '../../shared/types/websites'

export function useWebsites() {
  const auth = useAuth()
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
    return $fetch<T>(path, { method, body, signal, headers: { Authorization: `Bearer ${token}` }, retry: 0 })
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

  async function mutate(method: 'POST' | 'PATCH' | 'DELETE', id?: string, fqdn?: string) {
    if (saving.value || !auth.user.value) return false
    const owner = auth.user.value.id
    const current = ++generation
    controller?.abort()
    controller = new AbortController()
    saving.value = true
    loading.value = false
    error.value = ''
    try {
      await request(`/api/websites${id ? `/${id}` : ''}`, method, fqdn === undefined ? undefined : { fqdn }, controller.signal)
      if (current !== generation || auth.user.value?.id !== owner) return false
      // Reset pagination so an alphabetically renamed row cannot leave stale pages.
      await load()
      return true
    } catch (cause) {
      if (auth.user.value?.id === owner) error.value = message(cause)
      return false
    } finally { if (auth.user.value?.id === owner) saving.value = false }
  }

  watch(() => auth.user.value?.id, () => { reset(); void load() })
  onMounted(() => { void load() })
  onBeforeUnmount(reset)
  return { items, hasMore, loading, saving, error, load, mutate }
}
