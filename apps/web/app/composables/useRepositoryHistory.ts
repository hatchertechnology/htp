import type { RepositoryHistory } from '../../shared/types/repository'
import { validDateRange } from '#shared/utils/analytics'
export function useRepositoryHistory(site: () => string, start: () => string, end: () => string, enabled: () => boolean = () => true, polling = true) {
  const ws = useWorkspace()
  const history = ref<RepositoryHistory | null>(null)
  const busy = ref(false)
  const error = ref('')
  let generation = 0
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  async function load(more = false, poll = false) {
    clearTimeout(timer); controller?.abort(); controller = new AbortController()
    const current = ++generation
    const previous = history.value
    if (!more && !poll) history.value = null
    busy.value = false; error.value = ''
    if (!ws.user.value || !site() || !enabled() || !validDateRange(start(), end())) return
    busy.value = true
    try {
      const result = await ws.request<RepositoryHistory>(`/api/websites/${site()}/repository`, {
        query: { start_date: start(), end_date: end(), ...(more ? { before_id: previous?.commits.at(-1)?.id } : {}) }, signal: controller.signal,
      })
      if (current !== generation) return
      history.value = { ...result, commits: more ? [...(previous?.commits ?? []), ...result.commits] : result.commits }
      // Keep paginated history stable until explicitly refreshed.
      if (polling && result.repository?.enabled && !more) timer = setTimeout(() => { void load(false, true) }, 60000)
    } catch (cause) { if (current === generation) error.value = failureMessage(cause) }
    finally { if (current === generation) busy.value = false }
  }
  watch(() => [ws.user.value?.id, site(), start(), end(), enabled()], () => { void load() }, { immediate: true })
  onBeforeUnmount(() => { generation++; controller?.abort(); clearTimeout(timer) })
  return { history, busy, error, load }
}
