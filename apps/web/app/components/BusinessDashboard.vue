<script setup lang="ts">
import type { GoogleReport } from '../../shared/types/dashboard'
import type { BusinessLocation, BusinessPerformance, InsightHistory } from '../../shared/types/insights'
import { businessDays, businessTotal, displayJson } from '#shared/utils/insights'
import { metric } from '#shared/utils/analytics'
const ws = useWorkspace()
const { start, end, includeToday } = useReportRange()
const locations = useInsight<{ locations: BusinessLocation[] }>('business_locations', () => '')
const chosen = ref('')
const bindings = ref<string[]>([])
const profile = useInsight<{ location: Record<string, unknown> }>('business_profile', () => chosen.value || null, () => bindings.value.includes(chosen.value))
const performance = useInsight<BusinessPerformance>('business_performance', () => chosen.value || null, () => bindings.value.includes(chosen.value))
const historical = ref<InsightHistory | null>(null)
const busy = ref(false)
const error = ref('')
const linkBusy = ref(false)
let generation = 0
const localDays = computed(() => businessDays(performance.saved.value?.data))
const localMetrics = [
  { key: 'WEBSITE_CLICKS', label: 'Website clicks' }, { key: 'CALL_CLICKS', label: 'Call-button clicks' },
  { key: 'BUSINESS_DIRECTION_REQUESTS', label: 'Direction requests' },
  { key: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', label: 'Desktop Search impressions' },
  { key: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', label: 'Mobile Search impressions' },
  { key: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', label: 'Desktop Maps impressions' },
  { key: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', label: 'Mobile Maps impressions' },
]
const selectedMetric = ref('WEBSITE_CLICKS')
const localTrend = computed<GoogleReport>(() => ({
  metricHeaders: [{ name: selectedMetric.value }],
  rows: Object.entries(localDays.value).sort(([a], [b]) => a.localeCompare(b)).filter(([, values]) => values[selectedMetric.value] !== undefined).map(([date, values]) => ({
    dimensionValues: [{ value: date.replaceAll('-', '') }], metricValues: [{ value: String(values[selectedMetric.value]) }],
  })),
}))
const choices = computed(() => {
  const rows = [...(locations.saved.value?.data?.locations ?? [])]
  for (const id of bindings.value) if (!rows.some(row => row.name === id)) rows.push({ name: id, title: id })
  return rows
})
watch(() => [ws.user.value?.id, ws.selectedId.value], () => { chosen.value = ''; bindings.value = []; historical.value = null; error.value = ''; generation++ })
watch(() => [locations.saved.value?.sync.fetched_at, ws.user.value?.id, ws.selectedId.value], async () => {
  const current = ++generation
  if (!ws.user.value || !ws.selectedId.value) return
  try {
    const history = await locations.history()
    if (current !== generation) return
    bindings.value = history.bindings
    if (!chosen.value) chosen.value = history.bindings[0] ?? locations.saved.value?.data?.locations[0]?.name ?? ''
  } catch (cause) { if (current === generation) error.value = failureMessage(cause) }
}, { immediate: true })
async function readHistory(more = false) {
  const current = ++generation
  if (!ws.user.value || !ws.selectedId.value || !chosen.value) { historical.value = null; return }
  busy.value = true; error.value = ''
  if (!more) historical.value = null
  try {
    const result = await profile.history(more ? historical.value?.snapshots.at(-1)?.id : undefined)
    if (current !== generation) return
    const snapshots = result.snapshots.slice(0, 200)
    const existing = more ? historical.value?.changes ?? [] : []
    const changes = [...new Map([...existing, ...result.changes].map(change => [change.id, change])).values()].sort((a, b) => b.id - a.id)
    historical.value = { ...result, changes, snapshots: more ? [...(historical.value?.snapshots ?? []), ...snapshots] : snapshots }
  } catch (cause) { if (current === generation) error.value = failureMessage(cause) }
  finally { if (current === generation) busy.value = false }
}
watch(() => [chosen.value, start.value, end.value, profile.saved.value?.sync.fetched_at, performance.saved.value?.sync.fetched_at], () => { void readHistory() })
onBeforeUnmount(() => { generation++ })
async function toggleLink() {
  const user = ws.user.value?.id, site = ws.selectedId.value, location = chosen.value, linked = !bindings.value.includes(location)
  linkBusy.value = true; error.value = ''
  try {
    await ws.request(`/api/websites/${site}/business/location`, { method: 'PUT', body: { location_id: location, linked } })
    if (user !== ws.user.value?.id || site !== ws.selectedId.value) return
    bindings.value = linked ? [...bindings.value, location] : bindings.value.filter(id => id !== location)
    await readHistory()
  } catch (cause) { if (user === ws.user.value?.id && site === ws.selectedId.value) error.value = failureMessage(cause) }
  finally { linkBusy.value = false }
}
const comparison = computed(() => {
  const source = historical.value?.comparison
  const byDate = new Map<string, { date: string; sessions?: number; conversions?: number; clicks?: number; local?: number; speed?: number; lcp?: number | string; inp?: number | string; cls?: number | string; changes: string[] }>()
  const row = (date: string) => { if (!byDate.has(date)) byDate.set(date, { date, changes: [] }); return byDate.get(date)! }
  const gaDate = (value: string) => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
  for (const [index, item] of (source?.analytics?.daily.rows ?? []).entries()) row(gaDate(item.dimensionValues?.[0]?.value ?? '')).sessions = metric(source?.analytics?.daily, 'sessions', index)
  for (const [index, item] of (source?.conversions?.daily.rows ?? []).entries()) row(gaDate(item.dimensionValues?.[0]?.value ?? '')).conversions = metric(source?.conversions?.daily, 'keyEvents', index)
  for (const item of source?.search?.daily?.rows ?? []) if (item.keys[0]) row(item.keys[0]).clicks = item.clicks
  for (const [date, values] of Object.entries(businessDays(source?.business_performance))) row(date).local = values.WEBSITE_CLICKS
  for (const observation of source?.health ?? []) {
    const day = row(observation.day)
    if (observation.kind === 'pagespeed' && observation.data.performance != null) day.speed = Math.round(observation.data.performance * 100)
    if (observation.kind === 'crux') {
      day.lcp = observation.data.metrics?.largest_contentful_paint?.percentiles.p75
      day.inp = observation.data.metrics?.interaction_to_next_paint?.percentiles.p75
      day.cls = observation.data.metrics?.cumulative_layout_shift?.percentiles.p75
    }
  }
  for (const change of historical.value?.changes ?? []) row(change.observed_at.slice(0, 10)).changes.push(change.field === '__baseline' ? 'Tracking began' : fieldLabels[change.field] || change.field)
  return [...byDate.values()].filter(row => row.date >= start.value && row.date <= end.value).sort((a, b) => a.date.localeCompare(b.date))
})
const fieldLabels: Record<string, string> = { title: 'Business name', phoneNumbers: 'Phone numbers', categories: 'Categories', websiteUri: 'Website', regularHours: 'Regular hours', specialHours: 'Special hours', storefrontAddress: 'Address', profile: 'Description', openInfo: 'Open status', serviceArea: 'Service area', serviceItems: 'Services', attributes: 'Attributes' }
</script>
<template>
  <section class="insight-section" aria-labelledby="business-title">
    <div class="analytics-section-heading"><div><h2 id="business-title">Business Profile</h2><p>Local discovery, customer actions, and a history of profile changes</p></div><button v-if="ws.user.value" class="refresh-control" :disabled="locations.busy.value" @click="locations.load()">Reload saved locations</button></div>
    <p v-if="!ws.google.value.business" class="form-notice">Authorize Business Profile under <NuxtLink to="/connections">Connections</NuxtLink> to discover and track locations. Saved history remains available.</p>
    <p v-if="locations.error.value || error" role="alert" class="form-error">{{ error || locations.error.value }} <button @click="locations.load(); readHistory()">Try again</button></p><ReportSyncNotice label="Location discovery" :sync="locations.saved.value?.sync" />
    <div v-if="choices.length" class="business-picker"><label class="insight-control">Location <select v-model="chosen"><option v-for="location in choices" :key="location.name" :value="location.name">{{ location.title }}{{ location.storefrontAddress?.locality ? ` · ${location.storefrontAddress.locality}` : '' }}</option></select></label><UButton :loading="linkBusy" :disabled="!chosen || (!ws.google.value.business && !bindings.includes(chosen))" color="neutral" variant="outline" @click="toggleLink">{{ bindings.includes(chosen) ? 'Stop tracking location' : 'Track this location' }}</UButton><span>{{ bindings.length }} tracked</span></div>
    <p v-else class="compact-empty">{{ locations.busy.value || locations.saved.value?.sync.state === 'pending' ? 'Waiting for the background location discovery.' : 'No authorized locations have been collected. Enable the Business Profile APIs, authorize access, and manage the location in Google.' }}</p>
    <template v-if="chosen">
      <p v-if="!bindings.includes(chosen)" class="form-notice">Track this location to start scheduled profile and performance collection.</p>
      <ReportSyncNotice label="Profile contents" :sync="profile.saved.value?.sync" /><ReportSyncNotice label="Local performance" :sync="performance.saved.value?.sync" />
      <p v-if="profile.error.value || performance.error.value" role="alert" class="form-error">{{ profile.error.value || performance.error.value }}</p>
      <dl class="insight-totals"><div v-for="item in localMetrics" :key="item.key"><dt>{{ item.label }}</dt><dd>{{ businessTotal(localDays, item.key)?.toLocaleString() ?? '—' }}</dd></div></dl>
      <section class="report-panel traffic-panel"><header><h3>Local performance over time</h3><label>Local metric <select v-model="selectedMetric"><option v-for="item in localMetrics" :key="item.key" :value="item.key">{{ item.label }}</option></select></label></header><TrafficChart v-if="localTrend.rows?.length" :report="localTrend" :selected-metric="selectedMetric" :metric-label="localMetrics.find(item => item.key === selectedMetric)?.label" :start="start" :end="end" /><p v-else class="compact-empty">No saved daily values for this metric in the selected period.</p><p class="report-caption">Business Profile location dates. Missing daily values are unavailable; call-button clicks do not establish answered calls.</p></section>
      <details v-if="profile.saved.value?.data" class="report-panel insight-details"><summary>Current saved profile</summary><dl class="profile-fields"><div v-for="(value, key) in profile.saved.value.data.location" :key="key"><dt>{{ fieldLabels[key] || key }}</dt><dd><pre>{{ displayJson(value) }}</pre></dd></div></dl></details>
      <section class="report-panel"><header><h3>Profile change history</h3><button class="refresh-control" @click="includeToday">Include today in date range</button><button class="refresh-control" :disabled="busy" @click="readHistory()">Reload history</button></header><p class="report-caption">Observed {{ start }} through {{ end }} UTC. Collection starts when tracking is enabled. The first observation is a baseline; later entries preserve before and after values. The exact edit time and editor are unavailable.</p>
        <p v-if="!historical?.changes.length" class="compact-empty">{{ busy ? 'Reading saved profile observations…' : 'No observed changes in these dates. Include today to see newly collected observations.' }}</p>
        <ol v-else class="profile-timeline"><li v-for="change in historical.changes" :key="change.id"><details><summary><time :datetime="change.observed_at">{{ new Date(change.observed_at).toLocaleString() }}</time><strong>{{ change.field === '__baseline' ? 'Tracking baseline recorded' : fieldLabels[change.field] || change.field }}</strong></summary><p v-if="change.previous_observed_at" class="report-caption">Changed between {{ new Date(change.previous_observed_at).toLocaleString() }} and this observation.</p><div class="profile-diff"><div v-if="change.field !== '__baseline'"><h4>Before</h4><pre>{{ displayJson(change.before_value) }}</pre></div><div><h4>{{ change.field === '__baseline' ? 'Initial profile' : 'After' }}</h4><pre>{{ displayJson(change.after_value) }}</pre></div></div></details></li></ol>
        <button v-if="historical?.has_more" class="refresh-control" :disabled="busy" @click="readHistory(true)">Load older observations</button><p v-if="historical?.changes_truncated" class="form-notice">This range has more changes than can be shown. Narrow the date range to inspect all changes.</p>
      </section>
      <details open class="report-panel insight-details"><summary>Compare profile changes with daily results</summary><p class="report-caption">Dates follow each provider’s reporting timezone: GA4 property time, Search Console Pacific time, Business Profile location time; change observations use UTC. Same-day alignment is approximate and does not establish causation. Mobile PageSpeed scores use that day’s latest test; mobile CrUX values reflect overlapping 28-day windows. Missing values show as —.</p><div class="table-scroll"><table><thead><tr><th>Date</th><th>Observed profile changes</th><th>Sessions</th><th>Key events</th><th>Search clicks</th><th>Profile website clicks</th><th>Mobile PageSpeed</th><th>LCP (ms)</th><th>INP (ms)</th><th>CLS</th></tr></thead><tbody><tr v-for="row in comparison" :key="row.date"><td>{{ row.date }}</td><td>{{ [...new Set(row.changes)].join(', ') || '—' }}</td><td>{{ row.sessions?.toLocaleString() ?? '—' }}</td><td>{{ row.conversions?.toLocaleString() ?? '—' }}</td><td>{{ row.clicks?.toLocaleString() ?? '—' }}</td><td>{{ row.local?.toLocaleString() ?? '—' }}</td><td>{{ row.speed ?? '—' }}</td><td>{{ row.lcp ?? '—' }}</td><td>{{ row.inp ?? '—' }}</td><td>{{ row.cls ?? '—' }}</td></tr></tbody></table></div><p v-if="!comparison.length" class="compact-empty">Daily comparisons appear when the selected reports have been collected for these dates.</p></details>
    </template>
  </section>
</template>
