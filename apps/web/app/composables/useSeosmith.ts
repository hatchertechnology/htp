import type { AuditDetail, AuditHistory, AuditRun } from '../../shared/types/seosmith'
export function useSeosmith() {
  const ws = useWorkspace()
  const boundedSavedDetail = useRuntimeConfig().public.boundedSavedDetail === true
  const runs = ref<AuditRun[]>([]), selected = ref<AuditDetail | null>(null)
  const busy = ref(false), detailBusy = ref(false), importing = ref(false), error = ref(''), notice = ref('')
  const cursor = ref<AuditHistory['next_cursor']>(null)
  let generation = 0, detailGeneration = 0
  let controller: AbortController | undefined, detailController: AbortController | undefined
  async function select(id: string) {
    const gen = ++detailGeneration, site = ws.selectedId.value
    detailController?.abort(); const requestController = new AbortController(); detailController = requestController; selected.value = null; detailBusy.value = true; error.value = ''
    try {
      let result: AuditDetail
      if (boundedSavedDetail) {
        const token = await ws.accessToken()
        if (!token) throw new Error('Your session has ended. Sign in again.')
        const response = await fetch(`/api/websites/${site}/seo/audits/${id}/dashboard`, { headers: { Authorization: `Bearer ${token}` }, signal: requestController.signal })
        if (!response.ok || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('Seosmith reports could not load. Try again.')
        // response.json() rejects a truncated transport and malformed or empty JSON.
        const value: unknown = await response.json()
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Seosmith reports could not load. Try again.')
        const detail = value as AuditDetail
        if (detail.delivery_id !== id || !detail.summary || !detail.report || typeof detail.report !== 'object' || (detail.report_json != null && typeof detail.report_json !== 'string')) throw new Error('Seosmith reports could not load. Try again.')
        result = detail
      } else {
        result = await ws.request<AuditDetail>(`/api/websites/${site}/seo/audits/${id}`, { signal: requestController.signal })
      }
      if (gen === detailGeneration && site === ws.selectedId.value) selected.value = result
    } catch (cause) { if (gen === detailGeneration) error.value = failureMessage(cause) }
    finally { if (gen === detailGeneration) detailBusy.value = false }
  }
  async function load(more = false) {
    const gen = ++generation, site = ws.selectedId.value
    controller?.abort(); controller = new AbortController(); error.value = ''
    if (!more) { runs.value = []; cursor.value = null; selected.value = null; detailGeneration++; detailController?.abort(); detailBusy.value = false }
    if (!ws.user.value || !site) { busy.value = false; return }
    busy.value = true
    try {
      const result = await ws.request<AuditHistory>(`/api/websites/${site}/seo/audits`, { query: { limit: 50, ...(more ? cursor.value : {}) }, signal: controller.signal })
      if (gen !== generation) return
      runs.value = [...new Map([...(more ? runs.value : []), ...result.items].map(r => [r.delivery_id, r])).values()]
      cursor.value = result.has_more ? result.next_cursor : null
      if (!more && runs.value[0]) await select(runs.value[0].delivery_id)
    } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
    finally { if (gen === generation) busy.value = false }
  }
  async function importFile(file: File) {
    const gen = generation, site = ws.selectedId.value, user = ws.user.value?.id
    importing.value = true; error.value = ''; notice.value = ''
    try {
      if (file.size > 4_952_756) throw new Error('Choose a JSON report at most 4,952,756 bytes.')
      const report_json = await file.text()
      try { JSON.parse(report_json) } catch { throw new Error('This file is not a valid JSON report.') }
      const receipt = await ws.request<{delivery_id: string}>(`/api/websites/${site}/seo/audits/import`, { method: 'POST', body: { report_json } })
      if (gen !== generation || site !== ws.selectedId.value) return
      await load(); if (site !== ws.selectedId.value || user !== ws.user.value?.id) return; await select(receipt.delivery_id); notice.value = 'Run saved. Re-importing the same file will not create a duplicate.'
    } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
    finally { importing.value = false }
  }
  watch(() => [ws.user.value?.id, ws.selectedId.value, ws.selected.value?.fqdn], () => { notice.value = ''; void load() }, { immediate: true })
  onBeforeUnmount(() => { generation++; detailGeneration++; controller?.abort(); detailController?.abort() })
  return { runs, selected, busy, detailBusy, importing, error, notice, cursor, load, select, importFile }
}
