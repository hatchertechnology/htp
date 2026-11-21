<script setup lang="ts">
import type { SearchRow } from '../../shared/types/search'
const props = defineProps<{ websiteId: string; property: string; start: string; end: string }>()
type Candidate = { kind: string; page?: string; query?: string; interpretation?: string; evidence?: unknown; evidence_presentation?: { truncated: boolean } }
type Landing = { landing_page: string; metrics: Record<string, number> }
type Page = { available: boolean; reason: string | null; rows: (SearchRow | Candidate | Landing)[]; has_more: boolean; retained_rows: number | null; currency_code?: string | null; collection?: { truncated?: boolean | null; anonymized_queries?: string }; comparison?: { available: boolean; reason?: string; clicks?: { before: number; after: number } }; measurement?: { observed_at?: string } }
const ws = useWorkspace()
const dataset = ref('queries')
const offset = ref(0)
const data = ref<Page | null>(null)
const error = ref('')
const loading = ref(false)
let generation = 0
async function load() {
  const current = ++generation
  data.value = null; error.value = ''; loading.value = false
  if (!props.websiteId || !props.property) return
  loading.value = true
  try {
    const result = await ws.request<Page>(`/api/websites/${props.websiteId}/search/dataset`, { method: 'POST', body: { site_url: props.property, start_date: props.start, end_date: props.end, dataset: dataset.value, offset: offset.value, limit: 25 } })
    if (current === generation) data.value = result
  } catch (cause) { if (current === generation) error.value = failureMessage(cause) }
  finally { if (current === generation) loading.value = false }
}
watch(() => [props.websiteId, props.property, props.start, props.end, dataset.value], () => { offset.value = 0; void load() }, { immediate: true })
function move(delta: number) { offset.value += delta; void load() }
function rowLabel(row: SearchRow | Candidate | Landing) { return 'landing_page' in row ? row.landing_page : 'kind' in row ? [row.kind.replaceAll('_', ' '), row.query, row.page].filter(Boolean).join(' · ') : row.keys?.join(' · ') }
function isMetric(row: SearchRow | Candidate | Landing): row is SearchRow { return 'clicks' in row }
onBeforeUnmount(() => { generation++ })
</script>
<template>
  <section class="report-panel search-table" aria-labelledby="search-evidence-heading">
    <header><h3 id="search-evidence-heading">Saved search evidence</h3><label>Dataset <select v-model="dataset"><option value="queries">Queries</option><option value="pages">Pages</option><option value="query_pages">Query and page</option><option value="devices">Devices</option><option value="countries">Countries</option><option value="analysis">Review candidates</option><option value="landing_outcomes">Landing outcomes</option></select></label></header>
    <p class="tool-guidance">Exact-period snapshots only. Google returns bounded top rows and may omit anonymized queries; these are review leads, not a complete inventory or causal diagnosis.</p>
    <p v-if="loading" role="status">Reading saved evidence…</p><p v-else-if="error" role="alert" class="form-error">{{ error }} <button @click="load">Retry</button></p>
    <template v-else-if="data">
      <p v-if="!data.available">No saved {{ dataset.replaceAll('_', ' ') }} evidence is available for this exact period. Daily totals may still be available above.</p>
      <template v-else>
        <p v-if="data.measurement?.observed_at" class="tool-guidance">Last saved {{ new Date(data.measurement.observed_at).toLocaleString() }} · {{ data.retained_rows }} retained rows<span v-if="data.collection?.truncated === true"> · collection reached its limit</span><span v-else-if="data.collection?.truncated == null && dataset !== 'analysis' && dataset !== 'landing_outcomes'"> · collection completeness unknown</span></p>
        <p v-if="dataset === 'landing_outcomes'">GA4 landing outcomes cover all collected channels; they are not attributed to individual search queries.</p>
        <p v-if="dataset === 'analysis' && data.comparison?.available && data.comparison.clicks">Comparable prior-period clicks: {{ data.comparison.clicks.before }} → {{ data.comparison.clicks.after }}</p>
        <p v-else-if="dataset === 'analysis' && !data.comparison?.available">Period comparison unavailable{{ data.comparison?.reason ? `: ${data.comparison.reason.replaceAll('_', ' ')}` : '' }}.</p>
        <div v-if="data.rows.length" class="table-scroll"><table><thead><tr><th scope="col">Evidence</th><th v-if="dataset !== 'analysis' && dataset !== 'landing_outcomes'" scope="col">Clicks</th><th v-if="dataset !== 'analysis' && dataset !== 'landing_outcomes'" scope="col">Impressions</th><th v-if="dataset !== 'analysis' && dataset !== 'landing_outcomes'" scope="col">CTR</th><th v-if="dataset !== 'analysis' && dataset !== 'landing_outcomes'" scope="col">Position</th></tr></thead><tbody><tr v-for="(row, i) in data.rows" :key="i"><td>{{ rowLabel(row) }}<p v-if="'interpretation' in row">{{ row.interpretation }}</p><details v-if="'evidence' in row && row.evidence"><summary>Source evidence<span v-if="row.evidence_presentation?.truncated"> (first 25 rows)</span></summary><pre>{{ JSON.stringify(row.evidence, null, 2) }}</pre></details><p v-if="'metrics' in row">Sessions: {{ row.metrics.sessions }} · Key events: {{ row.metrics.keyEvents }} · Revenue: {{ row.metrics.totalRevenue }} {{ data.currency_code || 'currency not reported' }} · Session key event rate: {{ row.metrics.sessionKeyEventRate }}</p></td><template v-if="isMetric(row)"><td>{{ row.clicks }}</td><td>{{ row.impressions }}</td><td>{{ Number.isFinite(row.ctr) ? `${(row.ctr * 100).toFixed(1)}%` : '—' }}</td><td>{{ Number.isFinite(row.position) ? row.position.toFixed(1) : '—' }}</td></template></tr></tbody></table></div><p v-else>No rows returned in this saved dataset.</p>
        <p><button :disabled="offset === 0" @click="move(-25)">Previous</button> · Rows {{ data.rows.length ? offset + 1 : 0 }}–{{ offset + data.rows.length }} · <button :disabled="!data.has_more" @click="move(25)">Next</button></p>
      </template>
    </template>
  </section>
</template>
