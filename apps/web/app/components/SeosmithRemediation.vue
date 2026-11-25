<script setup lang="ts">
import type { AuditDetail } from '../../shared/types/seosmith'
import { findingEvaluation, findingPriority } from '#shared/utils/seosmith-remediation'
import { formatInstant } from '#shared/utils/local-time'
const props = defineProps<{ audit: AuditDetail }>()
type Attempt = { id: string; result: string; note: string; created_at: string; delivery_id: string | null }
type Work = { id: string; finding_index: number; status: string; assignee: string | null; segments: Record<string, string>; exception_note: string | null; notes: string | null; business_exposure: string | null; estimated_effort: string | null; rationale: string | null; attempts: Attempt[]; attempts_more: boolean }
const ws = useWorkspace()
const index = ref(0), cursors = ref<Array<{ before: string; before_id: string } | null>>([null]), cursorPage = ref(0), items = ref<Work[]>([]), busy = ref(false), message = ref(''), error = ref('')
const form = reactive({ status: 'open', assignee: '', page: '', template: '', locale: '', device: '', business: '', exception_note: '', notes: '', business_exposure: '', estimated_effort: '', rationale: '' })
const attemptNote = ref(''), attemptResult = ref('unverified'), attemptAudit = ref('')
const finding = computed(() => props.audit.report.findings[index.value])
const rankedFindings = computed(() => props.audit.report.findings.map((item, index) => ({ item, index })).sort((a, b) => ['critical', 'alert', 'warning'].indexOf(a.item.severity) - ['critical', 'alert', 'warning'].indexOf(b.item.severity) || a.index - b.index))
const current = computed(() => items.value.find(item => item.finding_index === index.value))
const evaluation = computed(() => findingEvaluation(props.audit.report, index.value))
const priority = computed(() => findingPriority(props.audit, index.value))
const endpoint = computed(() => `/api/websites/${ws.selectedId.value}/seo/audits/${props.audit.delivery_id}/work`)
const loaded = ref(false)
let retryPage = 0
let generation = 0
function populate() {
  const w = current.value
  Object.assign(form, { status: w?.status ?? 'open', assignee: w?.assignee ?? '', page: w?.segments.page ?? '', template: w?.segments.template ?? '', locale: w?.segments.locale ?? '', device: w?.segments.device ?? '', business: w?.segments.business ?? '', exception_note: w?.exception_note ?? '', notes: w?.notes ?? '', business_exposure: w?.business_exposure ?? '', estimated_effort: w?.estimated_effort ?? '', rationale: w?.rationale ?? '' })
  attemptNote.value = ''; attemptAudit.value = ''; attemptResult.value = 'unverified'
}
async function load(targetPage = cursorPage.value) {
  const gen = ++generation
  retryPage = targetPage
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    if (!props.audit.report.findings.length) return false
    const result = await ws.request<Work[]>(endpoint.value, { query: { finding_index: index.value, ...(cursors.value[targetPage] ?? {}) } })
    if (gen !== generation) return false
    items.value = result
    cursorPage.value = targetPage
    if (!loaded.value) populate()
    loaded.value = true
    return true
  } catch {
    if (gen === generation) error.value = 'Work items could not load. Try again.'
    return false
  } finally {
    if (gen === generation) busy.value = false
  }
}
function selectFinding() {
  loaded.value = false
  items.value = []
  populate()
  cursors.value = [null]
  cursorPage.value = 0
  void load(0)
}
watch(() => [props.audit.delivery_id, ws.selectedId.value], () => { index.value = 0; selectFinding() }, { immediate: true })
watch(index, selectFinding)
onBeforeUnmount(() => { generation++ })
async function save() {
  if (!loaded.value || busy.value) return
  const gen = generation
  busy.value = true; error.value = ''; message.value = ''
  try {
    const { page, template, locale, device, business, ...values } = form
    const optional = (s: string) => s.trim() || null
    await ws.request(endpoint.value, { method: 'POST', body: { finding_index: index.value, work: { ...Object.fromEntries(Object.entries(values).map(([k,v]) => [k,k === 'status' ? v : optional(v)])), segments: Object.fromEntries(Object.entries({ page, template, locale, device, business }).filter(([,v]) => v.trim())) } } })
    if (gen === generation && await load()) message.value = 'Work saved. Status does not verify a fix.'
  } catch { if (gen === generation) error.value = 'Work could not be saved. Check the fields and try again.' }
  finally { if (gen === generation) busy.value = false }
}
function newerAttempts() { if (cursorPage.value > 0) void load(cursorPage.value - 1) }
function olderAttempts() {
  const last = current.value?.attempts.at(-1)
  if (!last || !current.value?.attempts_more) return
  cursors.value = [...cursors.value.slice(0, cursorPage.value + 1), { before: last.created_at, before_id: last.id }]
  void load(cursorPage.value + 1)
}
async function addAttempt() {
  if (!loaded.value || busy.value || !current.value || !attemptNote.value.trim()) return
  const gen = generation
  const note = attemptNote.value
  const auditId = attemptAudit.value
  const result = attemptResult.value
  busy.value = true; error.value = ''; message.value = ''
  try {
    await ws.request(`/api/websites/${ws.selectedId.value}/seo/work/${current.value.id}/attempts`, { method: 'POST', body: { delivery_id: auditId.trim() || null, result, note: note.trim() } })
    if (gen !== generation) return
    if (attemptNote.value === note && attemptAudit.value === auditId && attemptResult.value === result) {
      attemptNote.value = ''; attemptAudit.value = ''; attemptResult.value = 'unverified'
    }
    if (await load(0)) message.value = 'Verification attempt recorded; no finding was automatically resolved.'
  } catch { if (gen === generation) error.value = 'The attempt could not be saved. Check the audit ID and try again.' }
  finally { if (gen === generation) busy.value = false }
}
</script>
<template>
  <section class="report-panel" aria-labelledby="remediation-title" :aria-busy="busy">
    <h3 id="remediation-title">Remediation work</h3>
    <p class="report-caption">Findings are ordered by technical severity. Plan against the saved evidence; work status and exceptions do not verify a fix. Business exposure, estimated effort and recommendation rationale are owner-entered and are not provider evidence.</p>
    <p v-if="error" role="alert" class="form-error">{{ error }} <button class="refresh-control" :disabled="busy" @click="load(retryPage)">Retry</button></p>
    <p v-if="message" role="status" class="form-notice">{{ message }}</p>
    <p v-if="!audit.report.findings.length" class="compact-empty">This audit has no findings to plan.</p>
    <template v-else>
      <label class="insight-control">Finding<select v-model.number="index" :disabled="busy"><option v-for="entry in rankedFindings" :key="entry.index" :value="entry.index">{{ entry.item.severity }} · {{ entry.item.rule }} · {{ entry.item.url }}</option></select></label>
      <p v-if="finding" class="report-caption">Evidence: {{ finding.evidence || 'Unavailable' }} · Source: /findings/{{ index }}. See evidence and coverage above.</p>
      <dl v-if="finding" class="priority-inputs" aria-label="Priority inputs"><div v-for="input in priority.inputs" :key="input.key"><dt>{{ input.label }}</dt><dd><strong>{{ input.state === 'known' ? input.value : input.state }}</strong> <span>{{ input.basis }}</span></dd></div></dl>
      <p v-if="finding" class="report-caption">{{ priority.rationale }}</p>
      <p class="report-caption">Collection interval: {{ audit.report.started_at || 'unknown' }} to {{ audit.report.finished_at || 'unknown' }}<template v-if="evaluation"> · Rule {{ evaluation.rule_version }} · Validator {{ evaluation.validator_version }} · Expected: {{ evaluation.expected.state === 'known' ? evaluation.expected.value : evaluation.expected.state === 'source' ? evaluation.expected.source_locator : 'unavailable' }}</template>.</p>
      <form v-if="loaded" class="seo-filters" @submit.prevent="save">
        <label>Status<select v-model="form.status"><option value="open">Open</option><option value="in_progress">In progress</option><option value="done">Done (unverified)</option><option value="excepted">Exception</option></select></label>
        <label>Owner<input v-model="form.assignee" maxlength="4096" /></label>
        <label>Page segment<input v-model="form.page" /></label><label>Template<input v-model="form.template" /></label><label>Locale<input v-model="form.locale" /></label><label>Device<input v-model="form.device" /></label><label>Business segment<input v-model="form.business" /></label>
        <label>Business exposure (optional)<input v-model="form.business_exposure" placeholder="Not assessed" /></label><label>Estimated effort (optional)<input v-model="form.estimated_effort" placeholder="Not assessed" /></label><label>Recommendation rationale<input v-model="form.rationale" placeholder="Not recorded" /></label><label>Exception reason<input v-model="form.exception_note" /></label><label>Notes<input v-model="form.notes" /></label>
        <button class="refresh-control" :disabled="busy">Save work</button>
      </form>
      <template v-if="current"><h4>Verification attempts</h4><p class="report-caption">An attempt records what was checked; it does not automatically resolve the finding.</p>
        <ul v-if="current.attempts.length"><li v-for="a in current.attempts" :key="a.id"><time :datetime="a.created_at" :title="a.created_at">{{ formatInstant(a.created_at) }}</time> · {{ a.result }} · {{ a.note }}<span v-if="a.delivery_id"> · audit {{ a.delivery_id }}</span></li></ul><p v-else class="compact-empty">No attempts recorded.</p><div v-if="cursorPage || current.attempts_more" class="seo-pagination"><button class="refresh-control" type="button" :disabled="busy || !cursorPage" @click="newerAttempts">Newer attempts</button><span>Page {{ cursorPage + 1 }}</span><button class="refresh-control" type="button" :disabled="busy || !current.attempts_more" @click="olderAttempts">Older attempts</button></div>
        <form class="seo-filters" @submit.prevent="addAttempt"><label>Result<select v-model="attemptResult"><option value="unverified">Unverified</option><option value="observed">Observation recorded</option></select></label><label>Related saved audit ID (optional)<input v-model="attemptAudit" /></label><label>What was checked<input v-model="attemptNote" required maxlength="4096" /></label><button class="refresh-control" :disabled="busy || !attemptNote.trim()">Record attempt</button></form>
      </template>
    </template>
  </section>
</template>
