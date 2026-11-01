import type { RepositoryIssues } from '../../shared/types/repository'

export function useRepositoryIssues() {
  const ws = useWorkspace()
  const state = ref<'open' | 'closed' | 'all'>('open')
  const result = ref<RepositoryIssues | null>(null)
  const busy = ref(false)
  const error = ref('')
  let page = 0
  let generation = 0
  let controller: AbortController | undefined

  async function load(more = false) {
    controller?.abort(); controller = new AbortController()
    const current = ++generation
    const nextPage = more ? page + 1 : 1
    if (!more) { result.value = null; page = 0 }
    busy.value = false; error.value = ''
    if (!ws.user.value || !ws.selectedId.value) return
    busy.value = true
    try {
      const data = await ws.request<RepositoryIssues>(`/api/websites/${ws.selectedId.value}/repository/issues`, {
        query: { state: state.value, page: nextPage }, signal: controller.signal,
      })
      if (current !== generation) return
      const previous = more && result.value?.repository_url === data.repository_url ? result.value.issues : []
      result.value = { ...data, issues: [...new Map([...previous, ...data.issues].map(issue => [issue.number, issue])).values()] }
      page = nextPage
    } catch (cause) { if (current === generation) error.value = failureMessage(cause) }
    finally { if (current === generation) busy.value = false }
  }
  watch(() => [ws.user.value?.id, ws.selectedId.value, state.value], () => { void load() }, { immediate: true, flush: 'sync' })
  onBeforeUnmount(() => { generation++; controller?.abort() })
  return { ws, state, result, busy, error, load }
}
