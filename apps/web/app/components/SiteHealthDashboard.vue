<script setup lang="ts">
import type { PageSpeedData, CruxData, InsightHistory } from '../../shared/types/insights'
import { sampledUrl, performanceSource, vitalValue } from '#shared/utils/page-performance'
const ws = useWorkspace()
const { start, end, includeToday } = useReportRange()
const device = ref('mobile')
const samplingEnabled = String(useRuntimeConfig().public.pagePerformanceSamples) === 'true'
const target = ref('')
const draft = ref('')
const targetError = ref('')
const samples = ref<string[]>([])
function chooseSample() {
  const url = sampledUrl(draft.value.trim(), ws.selected.value?.fqdn ?? '')
  if (!url || !draft.value.trim()) { targetError.value = 'Enter an HTTPS URL or path on the selected website, without a fragment or credentials.'; return }
  targetError.value = ''
  if (target.value === url) {
    // Assigning the same ref does not trigger source watchers. Retry failed
    // requests explicitly, including CrUX (which has no separate reload button).
    void speed.load(); void crux.load(); void readHistory()
  } else target.value = url
  if (!samples.value.includes(url)) samples.value.push(url)
}
watch(() => [ws.selectedId.value, ws.selected.value?.fqdn], () => { target.value = ''; draft.value = ''; targetError.value = ''; samples.value = [] })
const speed = useInsight<PageSpeedData>('pagespeed', () => performanceSource(device.value, target.value))
const crux = useInsight<CruxData>('crux', () => performanceSource(device.value === 'mobile' ? 'PHONE' : 'DESKTOP', target.value))
const historical = ref<InsightHistory<PageSpeedData> | null>(null)
const cruxHistorical = ref<InsightHistory<CruxData> | null>(null)
const historyError = ref('')
const historyBusy = ref(false)
let historyGeneration = 0
async function readHistory(more = false) {
  const current = ++historyGeneration
  if (!ws.selectedId.value || !ws.user.value) { historical.value = null; cruxHistorical.value = null; return }
  historyBusy.value = true; historyError.value = ''
  if (!more) { historical.value = null; cruxHistorical.value = null }
  try {
    const [result, cruxResult] = await Promise.all([
      more && !historical.value?.has_more ? null : speed.history(more ? historical.value?.snapshots.at(-1)?.id : undefined),
      more && !cruxHistorical.value?.has_more ? null : crux.history(more ? cruxHistorical.value?.snapshots.at(-1)?.id : undefined),
    ])
    if (current !== historyGeneration) return
    if (result) {
      samples.value = [...new Set([...(result.samples ?? []), ...(target.value ? [target.value] : [])])]
      const snapshots = result.snapshots.slice(0, 200)
      historical.value = { ...result, snapshots: more ? [...(historical.value?.snapshots ?? []), ...snapshots] : snapshots }
    }
    if (cruxResult) {
      const snapshots = cruxResult.snapshots.slice(0, 200)
      cruxHistorical.value = { ...cruxResult, snapshots: more ? [...(cruxHistorical.value?.snapshots ?? []), ...snapshots] : snapshots }
    }
  } catch (cause) { if (current === historyGeneration) historyError.value = failureMessage(cause) }
  finally { if (current === historyGeneration) historyBusy.value = false }
}
watch(() => [ws.user.value?.id, ws.selectedId.value, device.value, target.value, start.value, end.value, speed.saved.value?.sync.fetched_at, crux.saved.value?.sync.fetched_at], () => { void readHistory() }, { immediate: true })
onBeforeUnmount(() => { historyGeneration++ })
const audits = computed(() => Object.entries(speed.saved.value?.data?.lighthouseResult.audits ?? {}).filter(([, a]) => a.score !== null && a.score < 1).sort(([, a], [, b]) => (a.score ?? 1) - (b.score ?? 1)).slice(0, 12))
const vitalNames = [
  { key: 'largest_contentful_paint', label: 'Loading · LCP', good: 2500, poor: 4000, unit: 'ms' },
  { key: 'interaction_to_next_paint', label: 'Responsiveness · INP', good: 200, poor: 500, unit: 'ms' },
  { key: 'cumulative_layout_shift', label: 'Layout stability · CLS', good: 0.1, poor: 0.25, unit: '' },
]
const vitals = computed(() => vitalNames.map(v => {
  const p75 = crux.saved.value?.data?.record?.metrics[v.key]?.percentiles.p75
  const value = vitalValue(p75)
  return { ...v, value, state: value === null ? 'Unavailable' : value <= v.good ? 'Good' : value <= v.poor ? 'Needs improvement' : 'Poor' }
}))
function score(value: number | null | undefined) { return value == null ? '—' : Math.round(value * 100) }
function googleDate(date?: { year: number; month: number; day: number }) { return date ? `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}` : '' }
</script>
<template>
  <section class="insight-section" aria-labelledby="health-title">
    <div class="analytics-section-heading"><div><h2 id="health-title">Site health</h2><p>Page diagnostics and actual visitor experience</p></div><label class="insight-control">Device <select v-model="device" aria-label="Device"><option value="mobile">Mobile</option><option value="desktop">Desktop</option></select></label></div>
    <form v-if="samplingEnabled" class="performance-sampling" @submit.prevent="chooseSample">
      <label class="insight-control">Report scope <select v-model="target" aria-label="Report scope"><option value="">Homepage lab test / whole-origin field data</option><option v-for="url in samples" :key="url" :value="url">{{ url }}</option></select></label>
      <div class="sample-url"><label for="performance-url">Sample a priority page or template</label><div><input id="performance-url" v-model="draft" placeholder="/services or https://example.com/services" :disabled="!ws.selectedId.value"><button class="refresh-control" :disabled="!ws.selectedId.value || !ws.user.value">View page reports</button></div></div>
      <p v-if="targetError" class="form-error" role="alert">{{ targetError }}</p>
      <p class="report-caption">Up to ten active sampled URLs per website. Viewing a sample schedules daily collection for seven days; viewing it again extends collection. A template sample represents only that page.</p>
    </form>
    <div class="health-layout">
      <section class="report-panel"><header><h3>PageSpeed audit</h3><button class="refresh-control" :disabled="speed.busy.value" @click="speed.load()">Reload saved audit</button></header>
        <p v-if="speed.error.value" class="form-error" role="alert">{{ speed.error.value }}</p><ReportSyncNotice :sync="speed.saved.value?.sync" />
        <dl class="insight-totals"><div v-for="(category, key) in speed.saved.value?.data?.lighthouseResult.categories" :key="key"><dt>{{ category.title }}</dt><dd>{{ score(category.score) }}<small>/100</small></dd></div></dl>
        <p v-if="!speed.saved.value?.data" class="compact-empty">{{ !ws.user.value ? 'Sign in and choose a website to view its audits.' : 'The first daily audit will appear after collection is configured and Google is connected.' }}</p>
        <p v-else class="report-caption">Latest {{ device }} lab test · Lighthouse {{ speed.saved.value.data.lighthouseResult.lighthouseVersion }} · {{ speed.saved.value.data.url }}. One Lighthouse run; scores can vary. Collected {{ speed.saved.value.data.lighthouseResult.fetchTime || speed.saved.value.sync.fetched_at }}.</p>
        <p v-if="speed.saved.value?.data?.lighthouseResult.finalDisplayedUrl || speed.saved.value?.data?.lighthouseResult.finalUrl" class="report-caption">Final tested URL: {{ speed.saved.value.data.lighthouseResult.finalDisplayedUrl || speed.saved.value.data.lighthouseResult.finalUrl }}</p>
        <details v-if="speed.saved.value?.data" class="insight-details"><summary>Lab metrics and test environment</summary><p class="report-caption">TBT is a lab measurement and does not measure field INP. Missing metrics are unavailable.</p><dl class="vital-list"><div v-for="(label, id) in { 'largest-contentful-paint': 'LCP (ms)', 'cumulative-layout-shift': 'CLS', 'first-contentful-paint': 'FCP (ms)', 'total-blocking-time': 'TBT (ms)' }" :key="id"><dt>{{ label }}</dt><dd>{{ vitalValue(speed.saved.value.data.lighthouseResult.audits[id]?.numericValue) ?? '—' }}</dd></div></dl><pre class="performance-environment">{{ JSON.stringify({ settings: speed.saved.value.data.lighthouseResult.configSettings ?? 'Unavailable', environment: speed.saved.value.data.lighthouseResult.environment ?? 'Unavailable' }, null, 2) }}</pre></details>
        <details v-if="audits.length" class="insight-details"><summary>Issues to investigate ({{ audits.length }})</summary><ul class="audit-list"><li v-for="[id, audit] in audits" :key="id"><strong>{{ audit.title }}</strong><span v-if="audit.displayValue">{{ audit.displayValue }}</span></li></ul></details>
      </section>
      <section class="report-panel"><header><h3>Core Web Vitals</h3></header><p v-if="crux.error.value" role="alert" class="form-error">{{ crux.error.value }}</p><ReportSyncNotice :sync="crux.saved.value?.sync" />
        <dl class="vital-list"><div v-for="vital in vitals" :key="vital.key"><dt>{{ vital.label }}</dt><dd><strong>{{ vital.value == null ? '—' : `${vital.value.toLocaleString()} ${vital.unit}` }}</strong><span>{{ vital.state }}</span></dd></div></dl>
        <p v-if="crux.saved.value?.data?.available === false" class="compact-empty">Not enough eligible Chrome traffic for this {{ target ? 'page' : 'origin' }} and device. No origin fallback is substituted for page data. PageSpeed tests are still available.</p>
        <p v-if="target && crux.saved.value?.data?.record?.key?.url" class="report-caption">CrUX recorded URL: {{ crux.saved.value.data.record.key.url }}</p>
        <p class="report-caption">CrUX field data · {{ target ? 'URL' : 'Origin' }} scope · {{ target || `https://${ws.selected.value?.fqdn ?? ''}` }} · {{ device }} · 75th percentile over a rolling 28-day window. {{ crux.saved.value?.data?.record ? `${googleDate(crux.saved.value.data.record.collectionPeriod.firstDate)} through ${googleDate(crux.saved.value.data.record.collectionPeriod.lastDate)}.` : '' }} Overlapping windows are not independent daily samples.</p>
      </section>
    </div>
    <div class="observation-range"><p>History follows the selected date range. Latest results above show the most recent collection.</p><button class="refresh-control" @click="includeToday">Include today in date range</button></div>
    <details class="report-panel insight-details"><summary>PageSpeed observation history · {{ start }} to {{ end }} UTC</summary><p v-if="historyError" class="form-error" role="alert">{{ historyError }} <button @click="readHistory()">Try again</button></p><div class="table-scroll"><table><thead><tr><th>Collected</th><th>Performance</th><th>Accessibility</th><th>Best practices</th><th>SEO</th></tr></thead><tbody><tr v-for="row in historical?.snapshots" :key="row.id"><td>{{ new Date(row.fetched_at).toLocaleString() }}</td><td>{{ score(row.data.lighthouseResult.categories.performance?.score) }}</td><td>{{ score(row.data.lighthouseResult.categories.accessibility?.score) }}</td><td>{{ score(row.data.lighthouseResult.categories['best-practices']?.score) }}</td><td>{{ score(row.data.lighthouseResult.categories.seo?.score) }}</td></tr></tbody></table></div><p v-if="!historical?.snapshots.length" class="compact-empty">No saved observations in these dates. History starts when collection is enabled; include today to see new observations.</p><button v-if="historical?.has_more || cruxHistorical?.has_more" class="refresh-control" :disabled="historyBusy" @click="readHistory(true)">Load older observations</button></details>
    <details class="report-panel insight-details"><summary>CrUX observation history · {{ start }} to {{ end }} UTC</summary><div class="table-scroll"><table><thead><tr><th>Collected</th><th>Field-data period</th><th>LCP (ms)</th><th>INP (ms)</th><th>CLS</th></tr></thead><tbody><tr v-for="row in cruxHistorical?.snapshots" :key="row.id"><td>{{ new Date(row.fetched_at).toLocaleString() }}</td><td>{{ row.data.record ? `${googleDate(row.data.record.collectionPeriod.firstDate)} – ${googleDate(row.data.record.collectionPeriod.lastDate)}` : 'Unavailable' }}</td><td v-for="vital in vitalNames" :key="vital.key">{{ row.data.record?.metrics[vital.key]?.percentiles.p75 ?? '—' }}</td></tr></tbody></table></div><p v-if="!cruxHistorical?.snapshots.length" class="compact-empty">No saved CrUX observations in these dates. Each observation covers an overlapping 28-day field-data window.</p><button v-if="cruxHistorical?.has_more" class="refresh-control" :disabled="historyBusy" @click="readHistory(true)">Load older observations</button></details>
  </section>
</template>
