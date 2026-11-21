<script setup lang="ts">
import type { AuditDetail } from '../../shared/types/seosmith'
import { findingEvaluation } from '../../shared/utils/seosmith-remediation'
const props = defineProps<{ audit: AuditDetail }>()
type Attempt = { id: string; result: string; note: string; created_at: string; delivery_id: string | null }
type Work = { id: string; finding_index: number; status: string; assignee: string | null; segments: Record<string, string>; exception_note: string | null; notes: string | null; business_exposure: string | null; estimated_effort: string | null; rationale: string | null; attempts: Attempt[] }
const ws = useWorkspace()
const index = ref(0), items = ref<Work[]>([]), busy = ref(false), message = ref(''), error = ref('')
const form = reactive({ status: 'open', assignee: '', page: '', template: '', locale: '', device: '', business: '', exception_note: '', notes: '', business_exposure: '', estimated_effort: '', rationale: '' })
const attemptNote = ref(''), attemptResult = ref('unverified'), attemptAudit = ref('')
const finding = computed(() => props.audit.report.findings[index.value])
const rankedFindings = computed(() => props.audit.report.findings.map((item, index) => ({ item, index })).sort((a, b) => ['critical', 'alert', 'warning'].indexOf(a.item.severity) - ['critical', 'alert', 'warning'].indexOf(b.item.severity) || a.index - b.index))
const current = computed(() => items.value.find(item => item.finding_index === index.value))
const evaluation = computed(() => findingEvaluation(props.audit.report, index.value))
const endpoint = computed(() => `/api/websites/${ws.selectedId.value}/seo/audits/${props.audit.delivery_id}/work`)
let generation = 0
function populate() {
  const w = current.value
  Object.assign(form, { status: w?.status ?? 'open', assignee: w?.assignee ?? '', page: w?.segments.page ?? '', template: w?.segments.template ?? '', locale: w?.segments.locale ?? '', device: w?.segments.device ?? '', business: w?.segments.business ?? '', exception_note: w?.exception_note ?? '', notes: w?.notes ?? '', business_exposure: w?.business_exposure ?? '', estimated_effort: w?.estimated_effort ?? '', rationale: w?.rationale ?? '' })
  attemptNote.value = ''; attemptAudit.value = ''; attemptResult.value = 'unverified'
}
async function load() {
  const gen = ++generation; busy.value = true; error.value = ''; message.value = ''
  try { const result = await ws.request<Work[]>(endpoint.value); if (gen === generation) { items.value = result; populate() } }
  catch { if (gen === generation) { items.value = []; error.value = 'Work items could not load. Try again.' } }
  finally { if (gen === generation) busy.value = false }
}
watch(() => [props.audit.delivery_id, ws.selectedId.value], () => { index.value = 0; void load() }, { immediate: true })
watch(index, populate)
onBeforeUnmount(() => { generation++ })
async function save() {
  busy.value = true; error.value = ''; message.value = ''
  try {
    const { page, template, locale, device, business, ...values } = form
    const optional = (s: string) => s.trim() || null
    await ws.request(endpoint.value, { method: 'POST', body: { finding_index: index.value, work: { ...Object.fromEntries(Object.entries(values).map(([k,v]) => [k,k === 'status' ? v : optional(v)])), segments: Object.fromEntries(Object.entries({ page, template, locale, device, business }).filter(([,v]) => v.trim())) } } })
    await load(); message.value = 'Work saved. Status does not verify a fix.'
  } catch { error.value = 'Work could not be saved. Check the fields and try again.' }
  finally { busy.value = false }
}
async function addAttempt() {
  if (!current.value || !attemptNote.value.trim()) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    await ws.request(`/api/websites/${ws.selectedId.value}/seo/work/${current.value.id}/attempts`, { method: 'POST', body: { delivery_id: attemptAudit.value.trim() || null, result: attemptResult.value, note: attemptNote.value.trim() } })
    await load(); message.value = 'Verification attempt recorded; no finding was automatically resolved.'
  } catch { error.value = 'The attempt could not be saved. Check the audit ID and try again.' }
  finally { busy.value = false }
}
</script>
<template>
  <section class="report-panel" aria-labelledby="remediation-title" :aria-busy="busy">
    <h3 id="remediation-title">Remediation work</h3>
    <p class="report-caption">Findings are ordered by technical severity. Plan against the saved evidence; work status and exceptions do not verify a fix.</p>
    <p v-if="error" role="alert" class="form-error">{{ error }} <button class="refresh-control" @click="load">Retry</button></p>
    <p v-if="message" role="status" class="form-notice">{{ message }}</p>
    <p v-if="!audit.report.findings.length" class="compact-empty">This audit has no findings to plan.</p>
    <template v-else>
      <label class="insight-control">Finding<select v-model.number="index" :disabled="busy"><option v-for="entry in rankedFindings" :key="entry.index" :value="entry.index">{{ entry.item.severity }} · {{ entry.item.rule }} · {{ entry.item.url }}</option></select></label>
      <p v-if="finding" class="report-caption">Technical severity: {{ finding.severity }} · Evidence: {{ finding.evidence || 'Unavailable' }} · Source: /findings/{{ index }} · Confidence: {{ evaluation?.confidence ?? 'unknown' }} · Intended policy: unknown · Affected reach: unknown. Coverage: {{ audit.summary.coverage_complete ? 'complete crawl' : 'partial or unknown' }}.</p>
      <p class="report-caption">Collection interval: {{ audit.report.started_at || 'unknown' }} to {{ audit.report.finished_at || 'unknown' }}<template v-if="evaluation"> · Rule {{ evaluation.rule_version }} · Validator {{ evaluation.validator_version }} · Expected: {{ evaluation.expected.state === 'known' ? evaluation.expected.value : evaluation.expected.state === 'source' ? evaluation.expected.source_locator : 'unavailable' }}</template>.</p>
      <form class="seo-filters" @submit.prevent="save">
        <label>Status<select v-model="form.status"><option value="open">Open</option><option value="in_progress">In progress</option><option value="done">Done (unverified)</option><option value="excepted">Exception</option></select></label>
        <label>Owner<input v-model="form.assignee" maxlength="4096" /></label>
        <label>Page segment<input v-model="form.page" /></label><label>Template<input v-model="form.template" /></label><label>Locale<input v-model="form.locale" /></label><label>Device<input v-model="form.device" /></label><label>Business segment<input v-model="form.business" /></label>
        <label>Business exposure (optional)<input v-model="form.business_exposure" /></label><label>Estimated effort (optional)<input v-model="form.estimated_effort" /></label><label>Recommendation rationale<input v-model="form.rationale" /></label><label>Exception reason<input v-model="form.exception_note" /></label><label>Notes<input v-model="form.notes" /></label>
        <button class="refresh-control" :disabled="busy">Save work</button>
      </form>
      <template v-if="current"><h4>Verification attempts</h4><p class="report-caption">An attempt records what was checked; it does not automatically resolve the finding.</p>
        <ul v-if="current.attempts.length"><li v-for="a in current.attempts" :key="a.id">{{ a.created_at }} · {{ a.result }} · {{ a.note }}<span v-if="a.delivery_id"> · audit {{ a.delivery_id }}</span></li></ul><p v-else class="compact-empty">No attempts recorded.</p>
        <form class="seo-filters" @submit.prevent="addAttempt"><label>Result<select v-model="attemptResult"><option value="unverified">Unverified</option><option value="observed">Observation recorded</option></select></label><label>Related saved audit ID (optional)<input v-model="attemptAudit" /></label><label>What was checked<input v-model="attemptNote" required maxlength="4096" /></label><button class="refresh-control" :disabled="busy || !attemptNote.trim()">Record attempt</button></form>
      </template>
    </template>
  </section>
</template>
