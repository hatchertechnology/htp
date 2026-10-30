<script setup lang="ts">
import type { PageSpeedData, CruxData, InsightHistory } from '../../shared/types/insights'
const ws = useWorkspace()
const { start, end, includeToday } = useReportRange()
const device = ref('mobile')
const speed = useInsight<PageSpeedData>('pagespeed', () => device.value)
const crux = useInsight<CruxData>('crux', () => device.value === 'mobile' ? 'PHONE' : 'DESKTOP')
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
watch(() => [ws.user.value?.id, ws.selectedId.value, device.value, start.value, end.value, speed.saved.value?.sync.fetched_at, crux.saved.value?.sync.fetched_at], () => { void readHistory() }, { immediate: true })
onBeforeUnmount(() => { historyGeneration++ })
const audits = computed(() => Object.entries(speed.saved.value?.data?.lighthouseResult.audits ?? {}).filter(([, a]) => a.score !== null && a.score < 1).sort(([, a], [, b]) => (a.score ?? 1) - (b.score ?? 1)).slice(0, 12))
const vitalNames = [
  { key: 'largest_contentful_paint', label: 'Loading · LCP', good: 2500, poor: 4000, unit: 'ms' },
  { key: 'interaction_to_next_paint', label: 'Responsiveness · INP', good: 200, poor: 500, unit: 'ms' },
  { key: 'cumulative_layout_shift', label: 'Layout stability · CLS', good: 0.1, poor: 0.25, unit: '' },
]
const vitals = computed(() => vitalNames.map(v => {
  const p75 = crux.saved.value?.data?.record?.metrics[v.key]?.percentiles.p75
  const value = p75 === undefined ? null : Number(p75)
  return { ...v, value, state: value === null ? 'Unavailable' : value <= v.good ? 'Good' : value <= v.poor ? 'Needs improvement' : 'Poor' }
}))
function score(value: number | null | undefined) { return value == null ? '—' : Math.round(value * 100) }
function googleDate(date?: { year: number; month: number; day: number }) { return date ? `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}` : '' }
</script>
<template>
  <section class="insight-section" aria-labelledby="health-title">
    <div class="analytics-section-heading"><div><h2 id="health-title">Site health</h2><p>Homepage diagnostic tests and actual visitor experience</p></div><label class="insight-control">Device <select v-model="device"><option value="mobile">Mobile</option><option value="desktop">Desktop</option></select></label></div>
    <div class="health-layout">
      <section class="report-panel"><header><h3>PageSpeed audit</h3><button class="refresh-control" :disabled="speed.busy.value" @click="speed.load()">Reload saved audit</button></header>
        <p v-if="speed.error.value" class="form-error" role="alert">{{ speed.error.value }}</p><ReportSyncNotice :sync="speed.saved.value?.sync" />
        <dl class="insight-totals"><div v-for="(category, key) in speed.saved.value?.data?.lighthouseResult.categories" :key="key"><dt>{{ category.title }}</dt><dd>{{ score(category.score) }}<small>/100</small></dd></div></dl>
        <p v-if="!speed.saved.value?.data" class="compact-empty">{{ !ws.user.value ? 'Sign in and choose a website to view its audits.' : 'The first daily audit will appear after collection is configured and Google is connected.' }}</p>
        <p v-else class="report-caption">Latest {{ device }} homepage test · Lighthouse {{ speed.saved.value.data.lighthouseResult.lighthouseVersion }} · {{ speed.saved.value.data.url }}. Audit scores can vary between runs.</p>
        <details v-if="audits.length" class="insight-details"><summary>Issues to investigate ({{ audits.length }})</summary><ul class="audit-list"><li v-for="[id, audit] in audits" :key="id"><strong>{{ audit.title }}</strong><span v-if="audit.displayValue">{{ audit.displayValue }}</span></li></ul></details>
      </section>
      <section class="report-panel"><header><h3>Core Web Vitals</h3></header><p v-if="crux.error.value" role="alert" class="form-error">{{ crux.error.value }}</p><ReportSyncNotice :sync="crux.saved.value?.sync" />
        <dl class="vital-list"><div v-for="vital in vitals" :key="vital.key"><dt>{{ vital.label }}</dt><dd><strong>{{ vital.value == null ? '—' : `${vital.value.toLocaleString()} ${vital.unit}` }}</strong><span>{{ vital.state }}</span></dd></div></dl>
        <p v-if="crux.saved.value?.data?.available === false" class="compact-empty">Not enough eligible Chrome traffic for this site and device. PageSpeed tests are still available.</p>
        <p class="report-caption">CrUX · 75th percentile across this website’s origin, using a rolling 28-day window. {{ crux.saved.value?.data?.record ? `${googleDate(crux.saved.value.data.record.collectionPeriod.firstDate)} through ${googleDate(crux.saved.value.data.record.collectionPeriod.lastDate)}.` : '' }} This differs from a single homepage test.</p>
      </section>
    </div>
    <div class="observation-range"><p>History follows the selected date range. Latest results above show the most recent collection.</p><button class="refresh-control" @click="includeToday">Include today in date range</button></div>
    <details class="report-panel insight-details"><summary>PageSpeed observation history · {{ start }} to {{ end }} UTC</summary><p v-if="historyError" class="form-error" role="alert">{{ historyError }} <button @click="readHistory()">Try again</button></p><div class="table-scroll"><table><thead><tr><th>Collected</th><th>Performance</th><th>Accessibility</th><th>Best practices</th><th>SEO</th></tr></thead><tbody><tr v-for="row in historical?.snapshots" :key="row.id"><td>{{ new Date(row.fetched_at).toLocaleString() }}</td><td>{{ score(row.data.lighthouseResult.categories.performance?.score) }}</td><td>{{ score(row.data.lighthouseResult.categories.accessibility?.score) }}</td><td>{{ score(row.data.lighthouseResult.categories['best-practices']?.score) }}</td><td>{{ score(row.data.lighthouseResult.categories.seo?.score) }}</td></tr></tbody></table></div><p v-if="!historical?.snapshots.length" class="compact-empty">No saved observations in these dates. History starts when collection is enabled; include today to see new observations.</p><button v-if="historical?.has_more || cruxHistorical?.has_more" class="refresh-control" :disabled="historyBusy" @click="readHistory(true)">Load older observations</button></details>
    <details class="report-panel insight-details"><summary>CrUX observation history · {{ start }} to {{ end }} UTC</summary><div class="table-scroll"><table><thead><tr><th>Collected</th><th>Field-data period ends</th><th>LCP (ms)</th><th>INP (ms)</th><th>CLS</th></tr></thead><tbody><tr v-for="row in cruxHistorical?.snapshots" :key="row.id"><td>{{ new Date(row.fetched_at).toLocaleString() }}</td><td>{{ googleDate(row.data.record?.collectionPeriod.lastDate) || 'Insufficient data' }}</td><td v-for="vital in vitalNames" :key="vital.key">{{ row.data.record?.metrics[vital.key]?.percentiles.p75 ?? '—' }}</td></tr></tbody></table></div><p v-if="!cruxHistorical?.snapshots.length" class="compact-empty">No saved CrUX observations in these dates. Each observation covers an overlapping 28-day field-data window.</p><button v-if="cruxHistorical?.has_more" class="refresh-control" :disabled="historyBusy" @click="readHistory(true)">Load older observations</button></details>
  </section>
</template>
