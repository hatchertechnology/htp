import type { InsightHistory, InsightKind, SavedInsight } from '../../shared/types/insights'
import { validDateRange } from '#shared/utils/analytics'

// Every request reads database snapshots through the API. Polling never calls Google.
export function useInsight<T>(kind: InsightKind, source: () => string | null, enabled: () => boolean = () => true) {
  const ws = useWorkspace()
  const { start, end } = useReportRange()
  const saved = ref<SavedInsight<T> | null>(null)
  const error = ref('')
  const busy = ref(false)
  let generation = 0
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  async function load(poll = false) {
    clearTimeout(timer)
    const current = ++generation
    controller?.abort(); controller = new AbortController()
    if (!poll) saved.value = null
    error.value = ''; busy.value = false
    const property = source()
    if (!ws.user.value || !ws.selectedId.value || property === null || !enabled() || !validDateRange(start.value, end.value)) return
    busy.value = true
    try {
      const result = await ws.request<SavedInsight<T>>(`/api/websites/${ws.selectedId.value}/insights/report`, {
        method: 'POST', body: { kind, property_id: property, start_date: start.value, end_date: end.value }, signal: controller.signal,
      })
      if (current !== generation) return
      saved.value = result
      if (result.sync.connection_status === 'connected') timer = setTimeout(() => { void load(true) }, result.data ? 60000 : 10000)
    } catch (cause) { if (current === generation) error.value = failureMessage(cause) }
    finally { if (current === generation) busy.value = false }
  }
  async function history<R = T>(before?: number): Promise<InsightHistory<R>> {
    return ws.request<InsightHistory<R>>(`/api/websites/${ws.selectedId.value}/insights/history`, {
      method: 'POST', body: { kind, property_id: source(), start_date: start.value, end_date: end.value, before_id: before ?? null },
    })
  }
  watch(() => [ws.user.value?.id, ws.selectedId.value, ws.google.value.connected, ws.google.value.business, source(), enabled(), start.value, end.value], () => { void load() }, { immediate: true })
  onBeforeUnmount(() => { generation++; controller?.abort(); clearTimeout(timer) })
  return { saved, error, busy, load, history }
}
