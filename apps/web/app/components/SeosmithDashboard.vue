<script setup lang="ts">
import type { AuditMetric } from '#shared/utils/seosmith'
import { auditMetricLabels, safeAuditUrl, comparable, findingChanges } from '#shared/utils/seosmith'
import type { AuditDetail } from '../../shared/types/seosmith'
const ws = useWorkspace()
const { runs, selected, busy, detailBusy, importing, error, notice, cursor, load, select, importFile } = useSeosmith()
const urlPage = ref(1), urlSearch = ref(''), urlStatus = ref('all')
const metric = ref<AuditMetric>('findings'), severity = ref('all'), rule = ref('all'), search = ref(''), page = ref(1)
const fileInput = ref<HTMLInputElement | null>(null), comparisonBusy = ref(false), comparisonError = ref('')
const changes = ref<{ added: number; resolved: number; persistent: number; unverified: number } | null>(null)
let comparisonGeneration = 0
const summary = computed(() => selected.value?.summary)
const findings = computed(() => selected.value?.report.findings ?? [])
const ruleOptions = computed(() => [...new Set(findings.value.map(f => f.rule))].sort())
const filtered = computed(() => findings.value.filter(f => (severity.value === 'all' || f.severity === severity.value) && (rule.value === 'all' || f.rule === rule.value) && `${f.url} ${f.rule} ${f.evidence}`.toLowerCase().includes(search.value.toLowerCase())).sort((a, b) => ['critical', 'alert', 'warning'].indexOf(a.severity) - ['critical', 'alert', 'warning'].indexOf(b.severity) || a.url.localeCompare(b.url)))
const displayed = computed(() => filtered.value.slice((page.value - 1) * 50, page.value * 50))
const pages = computed(() => (selected.value?.report.pages ?? []).filter(p => p.url.toLowerCase().includes(urlSearch.value.toLowerCase()) && (urlStatus.value === 'all' || (urlStatus.value === 'errors' ? (p.status !== null && p.status >= 400) || !!p.error : p.content_type.startsWith(urlStatus.value)))))
const previous = computed(() => { const index = runs.value.findIndex(r => r.delivery_id === selected.value?.delivery_id); return index >= 0 ? runs.value[index + 1] : undefined })
const canCompare = computed(() => selected.value && previous.value && comparable(selected.value, previous.value))
watch(() => [selected.value?.delivery_id, urlSearch.value, urlStatus.value], () => { urlPage.value = 1 })
watch(() => [selected.value?.delivery_id, severity.value, rule.value, search.value], () => { page.value = 1 })
watch(() => selected.value?.delivery_id, () => { rule.value = 'all'; changes.value = null; comparisonError.value = ''; comparisonGeneration++; comparisonBusy.value = false })
onBeforeUnmount(() => { comparisonGeneration++ })
function stamp(value: string) { return new Date(value).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' }
function label(value: string) { return value.replaceAll('_', ' ') }
async function upload(event: Event) { const input = event.target as HTMLInputElement, file = input.files?.[0]; if (file) await importFile(file); input.value = '' }
async function compareRuns() {
  if (!selected.value || !previous.value || !canCompare.value) return
  const current = selected.value, older = previous.value, gen = ++comparisonGeneration
  comparisonBusy.value = true; comparisonError.value = ''
  try {
    const detail = await ws.request<AuditDetail>(`/api/websites/${ws.selectedId.value}/seo/audits/${older.delivery_id}`)
    if (gen === comparisonGeneration) changes.value = findingChanges(current, older, current.report.findings, detail.report.findings, current.report.pages)
  } catch (cause) { if (gen === comparisonGeneration) comparisonError.value = failureMessage(cause) }
  finally { if (gen === comparisonGeneration) comparisonBusy.value = false }
}
function download() {
  if (!selected.value) return
  const url = URL.createObjectURL(new Blob([selected.value.report_json || JSON.stringify(selected.value.report, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = `seosmith-${selected.value.delivery_id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>
<template>
  <section class="insight-section seosmith-section" aria-labelledby="seosmith-title" :aria-busy="busy">
    <div class="analytics-section-heading"><div><h2 id="seosmith-title">Technical SEO · Seosmith</h2><p>Every saved crawl, its findings, and how the site changes over time.</p></div><div v-if="ws.user.value && ws.selected.value" class="seo-actions"><button class="refresh-control" :disabled="busy || importing" @click="load()">Refresh audits</button><button class="refresh-control" :disabled="importing" @click="fileInput?.click()">{{ importing ? 'Saving run…' : 'Import JSON report' }}</button><input ref="fileInput" class="sr-only" type="file" accept="application/json,.json" aria-label="Import Seosmith JSON report" @change="upload" /></div></div>
    <p v-if="error" role="alert" class="form-error">{{ error }} <button @click="load()">Try again</button></p>
    <p v-if="notice" role="status" class="form-notice">{{ notice }}</p>
    <div v-if="!runs.length" class="report-panel chart-empty" aria-live="polite"><UIcon name="i-lucide-scan-search" /><h3>{{ !ws.user.value ? 'Sign in to see technical audits.' : !ws.selected.value ? 'Select a website for technical audits.' : busy ? 'Reading saved audits…' : error ? 'Audits could not load.' : 'No Seosmith runs saved yet.' }}</h3><p>Import a JSON report for this exact hostname, or connect a Seosmith worker. Every run is retained independently of Google and Bing.</p></div>
    <template v-else>
      <div class="report-panel seo-trend-panel"><header><div><h3>Audit history</h3><p class="report-caption">All dates · {{ runs.length }} runs loaded{{ cursor ? ' · more history available' : '' }}</p></div><label class="insight-control">Plot<select v-model="metric" aria-label="Audit chart metric"><option v-for="(text, key) in auditMetricLabels" :key="key" :value="key">{{ text }}</option></select></label></header><SeosmithTrend :runs="runs" :metric="metric" :selected-id="selected?.delivery_id" @select="select" /></div>
      <div class="seo-run-picker"><label>Inspect a run<select aria-label="Inspect a run" :value="selected?.delivery_id || ''" :disabled="detailBusy" @change="select(($event.target as HTMLSelectElement).value)"><option v-if="detailBusy" value="">Loading run…</option><option v-for="run in runs" :key="run.delivery_id" :value="run.delivery_id">{{ stamp(run.scan_at) }}{{ !run.summary.finished_at ? ' (receipt time)' : '' }} · {{ run.summary.outcome }} · {{ run.summary.pages.checked }} URLs · {{ run.summary.findings }} findings</option></select></label><button v-if="cursor" class="refresh-control" :disabled="busy" @click="load(true)">Load older runs</button></div>
      <p v-if="detailBusy" role="status" class="compact-empty">Loading this run’s findings…</p>
      <template v-if="selected && summary">
        <div class="insight-totals seo-summary"><div><span>URLs checked</span><strong>{{ summary.pages.checked.toLocaleString() }}</strong></div><div><span>Critical</span><strong>{{ summary.severities.critical.toLocaleString() }}</strong></div><div><span>Alerts</span><strong>{{ summary.severities.alert.toLocaleString() }}</strong></div><div><span>Warnings</span><strong>{{ summary.severities.warning.toLocaleString() }}</strong></div><div><span>HTTP errors</span><strong>{{ summary.pages.http_errors.toLocaleString() }}</strong></div></div>
        <p v-if="!summary.coverage_complete" class="form-notice" role="status">This run has incomplete coverage: {{ label(summary.stop_reason || summary.outcome) }}. Missing findings do not mean issues were fixed.</p>
        <p class="report-caption">{{ stamp(selected.scan_at) }} · {{ summary.outcome }} · {{ summary.pages.html }} successful HTML pages · {{ summary.pages.images }} images · {{ summary.pages.fetch_errors }} fetch errors.<span>Engine {{ summary.engine_version || 'unknown' }} · Ruleset {{ summary.ruleset_version || 'unknown' }} · {{ selected.report.request.max_pages }}-URL cap · {{ selected.ingestion_source === 'import' ? 'Imported report' : 'Worker delivery' }} · Received {{ stamp(selected.received_at) }}.</span></p>
        <div class="seo-actions"><button class="refresh-control" @click="download">Download run JSON</button><button v-if="canCompare" class="refresh-control" :disabled="comparisonBusy" @click="compareRuns">{{ comparisonBusy ? 'Comparing…' : 'Compare findings with previous run' }}</button></div>
        <p v-if="previous && !canCompare" class="report-caption">Finding changes are unavailable against the previous run because coverage or crawl settings, engine, or ruleset differ. Both observations remain in the chart.</p>
        <p v-if="changes" class="form-notice" role="status">Compared with the previous complete run: {{ changes.added }} new · {{ changes.resolved }} resolved · {{ changes.persistent }} persistent findings.<span v-if="changes.unverified"> {{ changes.unverified }} could not be verified from the current observations.</span></p><p v-if="comparisonError" class="form-error" role="alert">{{ comparisonError }}</p>
        <div class="report-panel seo-findings"><header><h3>Findings</h3><span>{{ filtered.length.toLocaleString() }} matching</span></header><div class="seo-filters"><label>Severity<select v-model="severity" aria-label="Severity"><option value="all">All severities</option><option value="critical">Critical</option><option value="alert">Alerts</option><option value="warning">Warnings</option></select></label><label>Rule<select v-model="rule" aria-label="Rule"><option value="all">All rules</option><option v-for="id in ruleOptions" :key="id" :value="id">{{ label(id) }}</option></select></label><label>Find a URL or issue<input v-model="search" type="search" placeholder="Search findings" /></label></div>
          <div class="table-scroll"><table><caption class="sr-only">Seosmith findings for the selected run</caption><thead><tr><th scope="col">Severity</th><th scope="col">Finding</th><th scope="col">Affected URL</th><th scope="col">Evidence</th></tr></thead><tbody><tr v-for="(finding, index) in displayed" :key="`${finding.key}-${index}`"><td><span class="seo-severity" :class="`seo-${finding.severity}`">{{ finding.severity }}</span></td><td>{{ label(finding.rule) }}</td><td><a v-if="safeAuditUrl(finding.url)" :href="safeAuditUrl(finding.url)" target="_blank" rel="noopener noreferrer">{{ finding.url }}</a><span v-else>{{ finding.url }}</span></td><td>{{ finding.evidence }}</td></tr></tbody></table></div><p v-if="!filtered.length" class="compact-empty">No findings match these filters.</p><div v-if="filtered.length > 50" class="seo-pagination"><button class="refresh-control" :disabled="page === 1" @click="page--">Previous findings</button><span>Page {{ page }} of {{ Math.ceil(filtered.length / 50) }}</span><button class="refresh-control" :disabled="page * 50 >= filtered.length" @click="page++">Next findings</button></div>
        </div>
        <details class="seo-pages seo-history-table"><summary>URLs checked in this run ({{ selected.report.pages.length }})</summary><div class="seo-filters"><label>Resource type<select v-model="urlStatus" aria-label="Resource type"><option value="all">All resources</option><option value="errors">HTTP / fetch errors</option><option value="text/html">HTML</option><option value="image/">Images</option></select></label><label>Find a checked URL<input v-model="urlSearch" type="search" placeholder="Search checked URLs" /></label></div><div class="table-scroll"><table><thead><tr><th>URL</th><th>Status</th><th>Title / type</th><th>Size (KiB)</th><th>Headers (ms)</th></tr></thead><tbody><tr v-for="(item, index) in pages.slice((urlPage - 1) * 50, urlPage * 50)" :key="`${item.url}-${index}`"><td><a v-if="safeAuditUrl(item.url)" :href="safeAuditUrl(item.url)" target="_blank" rel="noopener noreferrer">{{ item.url }}</a><span v-else>{{ item.url }}</span></td><td>{{ item.error ? 'Fetch failed' : item.blocked_by_robots ? 'Robots blocked' : item.status ?? 'Unavailable' }}</td><td>{{ item.title || item.content_type || 'Unavailable' }}</td><td>{{ (item.bytes / 1024).toFixed(1) }}</td><td>{{ item.status === null ? '—' : item.ttfb_ms }}</td></tr></tbody></table></div><p v-if="!pages.length" class="compact-empty">No checked URLs match these filters.</p><div v-if="pages.length > 50" class="seo-pagination"><button class="refresh-control" :disabled="urlPage === 1" @click="urlPage--">Previous URLs</button><span>Page {{ urlPage }} of {{ Math.ceil(pages.length / 50) }}</span><button class="refresh-control" :disabled="urlPage * 50 >= pages.length" @click="urlPage++">Next URLs</button></div></details>
      </template>
      <details class="seo-history-table"><summary>Saved runs ({{ runs.length }} loaded)</summary><div class="table-scroll"><table><thead><tr><th>Scan time (UTC)</th><th>Coverage</th><th>URLs checked</th><th>Critical</th><th>Alerts</th><th>Warnings</th></tr></thead><tbody><tr v-for="run in runs" :key="run.delivery_id"><td><button class="refresh-control" @click="select(run.delivery_id)">{{ stamp(run.scan_at) }}</button></td><td>{{ run.summary.coverage_complete ? 'Complete' : run.summary.outcome }}</td><td>{{ run.summary.pages.checked }}</td><td>{{ run.summary.severities.critical }}</td><td>{{ run.summary.severities.alert }}</td><td>{{ run.summary.severities.warning }}</td></tr></tbody></table></div></details>
    </template>
  </section>
</template>
