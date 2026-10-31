<script setup lang="ts">
import type { BingReport, BingRow } from '../../shared/types/bing'
import type { PendingReport, SyncStatus } from '../../shared/types/sync'
import type { GoogleReport } from '../../shared/types/dashboard'
import { bingDate, bingNumber, bingTraffic, bingIssue } from '#shared/utils/bing'
import { validDateRange } from '#shared/utils/analytics'
const ws = useWorkspace()
const { start, end } = useReportRange()
const report = ref<BingReport | null>(null)
const sync = ref<SyncStatus | null>(null)
const busy = ref(false)
const error = ref('')
const selectedMetric = ref('clicks')
let generation = 0
let controller: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
const traffic = computed(() => bingTraffic(report.value?.sections.traffic?.rows, start.value, end.value))
const clicks = computed(() => traffic.value.reduce((n, row) => n + row.clicks, 0))
const impressions = computed(() => traffic.value.reduce((n, row) => n + row.impressions, 0))
const daily = computed<GoogleReport>(() => ({ metricHeaders: [{ name: 'clicks' }, { name: 'impressions' }], rows: traffic.value.map(row => ({ dimensionValues: [{ value: row.date.replaceAll('-', '') }], metricValues: [{ value: String(row.clicks) }, { value: String(row.impressions) }] })) }))
const metrics = computed(() => [
  { label: 'Bing clicks', value: clicks.value.toLocaleString(), icon: 'i-lucide-mouse-pointer-2' },
  { label: 'Bing impressions', value: impressions.value.toLocaleString(), icon: 'i-lucide-eye' },
  { label: 'Click-through rate', value: impressions.value ? `${(clicks.value / impressions.value * 100).toFixed(1)}%` : '—', icon: 'i-lucide-percent' },
  { label: 'Days reported', value: String(traffic.value.length), icon: 'i-lucide-calendar-days' },
])
const tables = computed(() => (['queries', 'pages'] as const).map(key => ({ key, title: key === 'queries' ? 'Bing search queries' : 'Bing search pages', section: report.value?.sections[key], rows: [...(report.value?.sections[key]?.rows ?? [])].sort((a, b) => (bingDate(b.Date) ?? '').localeCompare(bingDate(a.Date) ?? '') || (bingNumber(b.Clicks) ?? 0) - (bingNumber(a.Clicks) ?? 0)).slice(0, 20) })))
const crawl = computed(() => [...(report.value?.sections.crawl?.rows ?? [])].filter(row => bingDate(row.Date)).sort((a, b) => bingDate(b.Date)!.localeCompare(bingDate(a.Date)!))[0])
const crawlMetrics = [{ key: 'InIndex', label: 'Indexed pages' }, { key: 'CrawledPages', label: 'Crawled pages' }, { key: 'CrawlErrors', label: 'Crawl errors' }, { key: 'BlockedByRobotsTxt', label: 'Robots.txt blocks' }, { key: 'InLinks', label: 'Inbound links' }]
const issues = computed(() => report.value?.sections.issues)
const sitemaps = computed(() => report.value?.sections.sitemaps)
function number(value: unknown, decimals = 0) { return bingNumber(value)?.toLocaleString(undefined, { maximumFractionDigits: decimals }) ?? '—' }
function text(value: unknown) { return typeof value === 'string' ? value : 'Not reported' }
function ctr(row: BingRow) { const c = bingNumber(row.Clicks), i = bingNumber(row.Impressions); return c !== null && i ? `${(c / i * 100).toFixed(1)}%` : '—' }
async function load(poll = false) {
  clearTimeout(timer)
  const current = ++generation
  controller?.abort(); controller = new AbortController()
  if (!poll) { report.value = null; sync.value = null }
  error.value = ''; busy.value = false
  if (!ws.user.value || !ws.selected.value || !ws.bingReady.value) return
  busy.value = true
  try {
    const data = await ws.request<BingReport | PendingReport>(`/api/websites/${ws.selectedId.value}/bing/dashboard`, { method: 'POST', body: {}, signal: controller.signal })
    if (current !== generation) return
    sync.value = data.sync ?? null
    if (!('code' in data)) report.value = data
    if (data.sync?.connection_status === 'connected') timer = setTimeout(() => { void load(true) }, 'code' in data ? 10_000 : 60_000)
  } catch (cause) { if (current === generation) error.value = failureMessage(cause) }
  finally { if (current === generation) busy.value = false }
}
watch(() => [ws.user.value?.id, ws.selectedId.value, ws.selected.value?.fqdn, ws.bingReady.value, ws.bing.value.connected, ws.bing.value.reauthorizationRequired], () => { void load() }, { immediate: true })
onBeforeUnmount(() => { generation++; controller?.abort(); clearTimeout(timer) })
</script>
<template>
  <section class="search-workspace" aria-labelledby="bing-heading">
    <div class="search-section-heading"><div><h2 id="bing-heading">Bing search &amp; site health</h2><p>{{ report?.site_url || 'Search traffic, crawl health, and sitemaps from Bing Webmaster Tools.' }}</p></div><button v-if="ws.user.value && ws.selected.value" class="refresh-control" :disabled="busy" @click="load(true)"><UIcon name="i-lucide-refresh-cw" /><span>Refresh Bing report</span></button></div>
    <p v-if="error" class="form-error" role="alert">{{ error }} <button @click="load()">Retry Bing</button></p>
    <ReportSyncNotice :sync="sync" provider="Bing" />
    <div v-if="!report?.site_url" class="report-panel chart-empty" aria-live="polite">
      <UIcon :name="busy ? 'i-lucide-loader-circle' : 'i-lucide-search'" :class="{ 'loading-spin': busy }" />
      <h3>{{ !ws.user.value ? 'Sign in to see Bing reports.' : !ws.selected.value ? 'Select a website for Bing reports.' : busy ? 'Reading saved Bing data…' : error ? 'Bing data could not load.' : sync?.last_error ? 'The latest Bing collection failed.' : sync?.connection_status === 'reauthorization_required' ? 'Reconnect Bing to resume collection.' : !sync?.connection_status || sync.connection_status === 'disconnected' ? 'Connect Bing to start collecting data.' : report ? 'No matching verified Bing website.' : 'Waiting for the first Bing sync.' }}</h3>
      <p v-if="report && sync?.connection_status === 'connected'">Verify this exact hostname in Bing Webmaster Tools. Hatch checks for matching root properties daily.</p>
      <p v-else>Daily reports remain available after disconnecting. The first collection starts after you connect.</p>
      <UButton to="/connections" color="neutral" variant="outline">Manage Bing connection</UButton>
    </div>
    <template v-else>
      <p v-if="report.sections.traffic?.error" class="form-notice" role="status">Bing traffic is unavailable in this saved report. Other sections may still be available.</p>
      <div class="traffic-layout" :aria-busy="busy">
        <section class="report-panel traffic-panel"><header><h3>Bing traffic over time</h3><label class="sr-only" for="bing-metric">Bing chart metric</label><select id="bing-metric" v-model="selectedMetric"><option value="clicks">Clicks</option><option value="impressions">Impressions</option></select></header>
          <TrafficChart v-if="traffic.length && validDateRange(start, end)" :report="daily" :selected-metric="selectedMetric" :start="start" :end="end" />
          <div v-else class="chart-empty"><h3>No Bing traffic rows for this period.</h3><p>Use the date range above to explore available daily data. Missing days are unavailable, rather than confirmed zero activity.</p></div>
        </section>
        <div class="summary-stack" aria-label="Bing traffic summary"><div v-for="item in metrics" :key="item.label" class="summary-panel"><UIcon :name="item.icon" /><div><span>{{ item.label }}</span><strong>{{ traffic.length ? item.value : '—' }}</strong></div></div></div>
      </div>
      <p class="report-caption">Bing traffic combines search surfaces, including web, chat, images, news, and video.<span>Chart and totals use returned daily rows within the selected dates, preserving Bing’s calendar dates. Google’s web-search totals cover a different scope.</span></p>
      <div class="search-rankings">
        <section v-for="table in tables" :key="table.key" class="report-panel search-table"><header><h3>{{ table.title }}</h3></header>
          <p class="report-caption">Latest Bing report · may refresh weekly · independent of the date filter. Up to 20 rows, newest dates first. Position is the average impression position.</p>
          <div v-if="table.rows.length" class="table-scroll"><table><caption class="sr-only">{{ table.title }} with provider dates</caption><thead><tr><th scope="col">{{ table.key === 'queries' ? 'Query' : 'Page' }}</th><th scope="col">Bing date</th><th scope="col" class="numeric">Clicks</th><th scope="col" class="numeric">Impressions</th><th scope="col" class="numeric">CTR</th><th scope="col" class="numeric" title="Average impression position">Position</th></tr></thead><tbody><tr v-for="(row, i) in table.rows" :key="i"><td class="search-dimension">{{ text(row.Query) }}</td><td>{{ bingDate(row.Date) || 'Not reported' }}</td><td class="numeric">{{ number(row.Clicks) }}</td><td class="numeric">{{ number(row.Impressions) }}</td><td class="numeric">{{ ctr(row) }}</td><td class="numeric">{{ number(row.AvgImpressionPosition, 1) }}</td></tr></tbody></table></div>
          <p v-else class="search-table-empty">{{ table.section?.error ? 'This Bing report is temporarily unavailable.' : 'Bing returned no rows for this section.' }}</p>
        </section>
      </div>
      <section class="report-panel url-workbench"><header><div><h3>Bing crawl health</h3><p>Latest Bing date: {{ bingDate(crawl?.Date) || 'Not reported' }} · Independent of the date filter.</p></div></header>
        <p v-if="report.sections.crawl?.error" class="form-notice">Crawl statistics are unavailable in this saved report.</p>
        <div v-else-if="crawl" class="inspection-result"><dl><div v-for="item in crawlMetrics" :key="item.key"><dt>{{ item.label }}</dt><dd>{{ number(crawl[item.key]) }}</dd></div></dl></div>
        <p v-else class="search-table-empty">Bing returned no crawl statistics.</p>
      </section>
      <div class="search-rankings">
        <section class="report-panel search-table"><header><h3>Crawl issues</h3></header><p class="report-caption">Latest Bing issue list · fixed issues may take several days to disappear · up to 20 shown.</p><div v-if="issues?.rows?.length" class="table-scroll"><table><thead><tr><th scope="col">URL</th><th scope="col">Issue</th><th scope="col">HTTP</th></tr></thead><tbody><tr v-for="(row, i) in issues.rows.slice(0, 20)" :key="i"><td class="search-dimension">{{ text(row.Url) }}</td><td>{{ bingIssue(row.Issues) }}</td><td>{{ number(row.HttpCode) }}</td></tr></tbody></table></div><p v-else class="search-table-empty">{{ issues?.error ? 'Crawl issues are unavailable in this saved report.' : 'Bing returned no crawl issues.' }}</p></section>
        <section class="report-panel search-table"><header><h3>Sitemaps</h3></header><p class="report-caption">Current top-level feeds · up to 20 shown.</p><div v-if="sitemaps?.rows?.length" class="table-scroll"><table><thead><tr><th scope="col">Sitemap</th><th scope="col">Status</th><th scope="col">Last crawl</th><th scope="col" class="numeric">URLs</th></tr></thead><tbody><tr v-for="(row, i) in sitemaps.rows.slice(0, 20)" :key="i"><td class="search-dimension">{{ text(row.Url) }}</td><td>{{ text(row.Status) }}</td><td>{{ bingDate(row.LastCrawled) || 'Not reported' }}</td><td class="numeric">{{ number(row.UrlCount) }}</td></tr></tbody></table></div><p v-else class="search-table-empty">{{ sitemaps?.error ? 'Sitemaps are unavailable in this saved report.' : 'Bing returned no sitemaps.' }}</p></section>
      </div>
    </template>
  </section>
</template>
<style scoped>
.search-table th, .search-table td { padding-right: 12px; }
.search-table th:last-child, .search-table td:last-child { padding-right: 0; }
.search-table th:not(:first-child), .search-table td:not(:first-child) { white-space: nowrap; }
.search-dimension { min-width: 120px; overflow-wrap: anywhere; }
</style>
