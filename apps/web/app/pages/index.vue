<script setup lang="ts">
import type { PendingReport, SyncStatus } from '../../shared/types/sync'
import type { DashboardReport } from '../../shared/types/dashboard'
import { metric, validDateRange } from '#shared/utils/analytics'
useHead({ title: 'Hatch · Website overview' })
const ws = useWorkspace()
const { start, end } = useReportRange()
const report = ref<DashboardReport | null>(null)
const busy = ref(false)
const sync = ref<SyncStatus | null>(null)
let pollTimer: ReturnType<typeof setTimeout> | undefined
const error = ref('')
const selectedMetric = ref('sessions')
let generation = 0
let controller: AbortController | null = null
const summary = computed(() => report.value?.report.summary)
const metrics = computed(() => [
  { label: 'Active users', name: 'activeUsers', icon: 'i-lucide-users-round', value: metric(summary.value, 'activeUsers').toLocaleString(), help: 'Distinct active users across the selected period.' },
  { label: 'Sessions', name: 'sessions', icon: 'i-lucide-layers-3', value: metric(summary.value, 'sessions').toLocaleString(), help: 'Sessions matching this website’s hostname.' },
  { label: 'Page views', name: 'screenPageViews', icon: 'i-lucide-file', value: metric(summary.value, 'screenPageViews').toLocaleString(), help: 'Views of pages on this website.' },
  { label: 'Engagement rate', name: 'engagementRate', icon: 'i-lucide-chart-no-axes-column-increasing', value: `${(metric(summary.value, 'engagementRate') * 100).toFixed(1)}%`, help: 'The proportion of sessions that were engaged.' },
])
const needs = computed(() => !ws.user.value ? { title: 'Your websites, in perspective.', body: 'Sign in to see how your websites are performing, with a clear view of the people and pages behind the numbers.', label: 'Sign in to Hatch', to: '/connections' } : !ws.selected.value ? { title: 'Start with a website.', body: 'Add a domain, then connect its Google Analytics property to bring your first performance report into focus.', label: 'Add a website', to: '/websites' } : !ws.selected.value.ga4_property_id ? { title: 'Choose this website’s property.', body: 'Link the numeric GA4 property ID that collects data for this website. You can find it in Google Analytics property settings.', label: 'Link a property', to: '/websites' } : null)
const devices = computed(() => (report.value?.report.devices.rows ?? []).map((r, i) => ({ label: r.dimensionValues?.[0]?.value || '(not set)', count: metric(report.value?.report.devices, 'sessions', i) })))
const deviceTotal = computed(() => devices.value.reduce((n, d) => n + d.count, 0))
const colors = ['#182c3d', '#c7633a', '#9baebc', '#7b8d81']
const deviceSlices = computed(() => {
  let offset = 0
  return devices.value.map((d, i) => { const share = deviceTotal.value ? d.count / deviceTotal.value * 100 : 0; const result = { ...d, share, offset, color: colors[i % colors.length] }; offset += share; return result })
})
const warning = computed(() => Object.values(report.value?.report ?? {}).some(r => r.metadata?.subjectToThresholding || r.metadata?.dataLossFromOtherRow || r.metadata?.samplingMetadatas?.length))
const connecting = ref(false)
async function connectGoogle() {
  connecting.value = true; error.value = ''
  try { const data = await ws.request<{url:string}>('/api/google/connect', {method:'POST'}); window.location.assign(data.url) }
  catch (cause) { error.value = failureMessage(cause); connecting.value = false }
}

async function load(poll = false) {
  clearTimeout(pollTimer)
  const current = ++generation; controller?.abort(); controller = new AbortController()
  if (!poll) { report.value = null; sync.value = null }
  error.value = ''; busy.value = false
  if (needs.value || !validDateRange(start.value, end.value) || !ws.connectionReady.value) return
  busy.value = true
  try {
    const data = await ws.request<DashboardReport | PendingReport>(`/api/websites/${ws.selectedId.value}/analytics/dashboard`, { method: 'POST', body: { property_id: ws.selected.value!.ga4_property_id, start_date: start.value, end_date: end.value }, signal: controller.signal })
    if (current === generation) {
      sync.value = data.sync ?? null
      if (!('code' in data)) report.value = data
      if (data.sync?.connection_status === 'connected') pollTimer = setTimeout(() => { void load(true) }, 'code' in data ? 10000 : 60000)
    }
  } catch (cause) { if (current === generation) error.value = failureMessage(cause) }
  finally { if (current === generation) busy.value = false }
}
watch(() => [ws.user.value?.id, ws.selectedId.value, ws.selected.value?.ga4_property_id, ws.google.value.connected, ws.connectionReady.value, start.value, end.value], () => { void load() }, { immediate: true })
onBeforeUnmount(() => { clearTimeout(pollTimer); generation++; controller?.abort() })
</script>

<template>
  <div class="overview-page">
    <div class="overview-heading"><div><h1>Website overview</h1><p>{{ ws.selected.value?.fqdn || 'A clearer view of your websites.' }}</p></div></div>
    <p v-if="ws.error.value" role="alert" class="form-error">{{ ws.error.value }} <button @click="ws.load">Try again</button></p>
    <nav class="report-navigation" aria-label="Website reports">
      <a href="#search-heading">Search</a><a href="#onsite-heading">Visitors</a><a href="#conversions-title">Conversions &amp; revenue</a><a href="#health-title">PageSpeed &amp; Core Web Vitals</a><a href="#business-title">Business Profile &amp; changes</a>
    </nav>
    <SearchDashboard />
    <div class="analytics-section-heading"><div><h2 id="onsite-heading">Onsite performance</h2><p>What visitors do after they arrive · Google Analytics</p></div><button v-if="report" class="refresh-control" :disabled="busy" @click="load()"><UIcon name="i-lucide-refresh-cw" /><span>Refresh analytics</span></button></div>
    <p v-if="error" role="alert" class="form-error">{{ error }} <button @click="load()">Try again</button><NuxtLink to="/connections">Manage connection</NuxtLink></p>
    <ReportSyncNotice :sync="sync" />
    <div class="traffic-layout" :aria-busy="busy">
      <section class="report-panel traffic-panel"><header><h2>Traffic over time</h2><label class="sr-only" for="chart-metric">Chart metric</label><select id="chart-metric" v-model="selectedMetric" :disabled="!report"><option value="sessions">Sessions</option><option value="activeUsers">Active users</option><option value="screenPageViews">Page views</option></select></header>
        <TrafficChart v-if="report?.report.daily.rows?.length" :report="report.report.daily" :selected-metric="selectedMetric" :start="start" :end="end" />
        <div v-else class="chart-empty" aria-live="polite"><template v-if="busy"><UIcon name="i-lucide-loader-circle" class="loading-spin" /><h3>Bringing your report together…</h3><p>Reading the latest saved Google Analytics report.</p></template><template v-else-if="needs"><UIcon :name="!ws.user.value ? 'i-lucide-chart-no-axes-combined' : 'i-lucide-link'" /><h3>{{ needs.title }}</h3><p>{{ needs.body }}</p><UButton v-if="ws.user.value && ws.selected.value && !ws.google.value.analytics" :loading="connecting" trailing-icon="i-lucide-arrow-right" @click="connectGoogle">{{ needs.label }}</UButton><UButton v-else :to="needs.to" trailing-icon="i-lucide-arrow-right">{{ needs.label }}</UButton></template><template v-else-if="error"><UIcon name="i-lucide-cloud-off" /><h3>This report could not load.</h3><p>Your website is saved. Try again, or check your Google connection.</p></template><template v-else-if="sync?.state === 'pending'"><UIcon name="i-lucide-clock" /><h3>Waiting for the first sync.</h3><p>Your saved report will appear here automatically.</p></template><template v-else><UIcon name="i-lucide-chart-no-axes-combined" /><h3>No activity in this period.</h3><p>Try a wider date range. This report includes the exact hostname shown above.</p></template></div>
      </section>
      <div class="summary-stack" aria-label="Performance summary"><div v-for="item in metrics" :key="item.name" class="summary-panel"><UIcon :name="item.icon" /><div><span :title="item.help">{{ item.label }}</span><strong>{{ report ? item.value : '—' }}</strong></div></div></div>
    </div>
    <div class="detail-layout">
      <RankedReport title="Channels" :report="report?.report.channels" dimension="Channel" metric-name="sessions" metric-label="Sessions" :total="metric(summary, 'sessions')" :waiting="!report" />
      <RankedReport title="Top pages" :report="report?.report.pages" dimension="Page" metric-name="screenPageViews" metric-label="Page views" :total="metric(summary, 'screenPageViews')" :waiting="!report" />
      <section class="report-panel devices-panel"><header><h2>Devices</h2></header><div v-if="deviceTotal" class="device-content"><svg viewBox="0 0 120 120" role="img" aria-label="Sessions by device category"><circle cx="60" cy="60" r="43" fill="none" stroke="#e6ebef" stroke-width="20" /><circle v-for="slice in deviceSlices" :key="slice.label" cx="60" cy="60" r="43" fill="none" :stroke="slice.color" stroke-width="20" pathLength="100" :stroke-dasharray="`${slice.share} ${100 - slice.share}`" :stroke-dashoffset="-slice.offset" transform="rotate(-90 60 60)" /><text x="60" y="59" text-anchor="middle" class="donut-total">{{ deviceTotal.toLocaleString() }}</text><text x="60" y="73" text-anchor="middle" class="donut-label">Sessions</text></svg><ul><li v-for="slice in deviceSlices" :key="slice.label"><span class="legend-dot" :style="{ background: slice.color }" /><span class="device-name">{{ slice.label }}</span><strong>{{ slice.share.toFixed(1) }}%</strong></li></ul></div><p v-else class="compact-empty">{{ !report ? 'Your report will appear here.' : 'No device data for this period.' }}</p></section>
    </div>
    <ConversionDashboard />
    <SiteHealthDashboard />
    <BusinessDashboard />
    <p v-if="report" class="report-caption">Google Analytics · Property {{ report.property_id }} · {{ report.report.summary.metadata?.timeZone || 'Property timezone' }} · Exact hostname: {{ report.website.fqdn }}<span v-if="warning">Google reports sampling, thresholding, or grouped rows; some small counts may be withheld.</span></p>
  </div>
</template>
