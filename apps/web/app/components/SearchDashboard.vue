<script setup lang="ts">
import type { PendingReport, SyncStatus } from '../../shared/types/sync'
import type { GoogleReport } from '../../shared/types/dashboard'
import type { SearchProperty, SearchReport, SearchRow, Inspection } from '../../shared/types/search'
import { validDateRange } from '#shared/utils/analytics'
const ws = useWorkspace()
const { start, end } = useReportRange()
const properties = ref<SearchProperty[]>([])
const property = ref('')
const discovering = ref(false)
const discoveryError = ref('')
const report = ref<SearchReport | null>(null)
const busy = ref(false)
const error = ref('')
const sync = ref<SyncStatus | null>(null)
const propertySync = ref<SyncStatus | null>(null)
let discoveryTimer: ReturnType<typeof setTimeout> | undefined
let reportTimer: ReturnType<typeof setTimeout> | undefined
const selectedMetric = ref('clicks')
const pageUrl = ref('')
const toolBusy = ref(false)
const toolError = ref('')
const inspection = ref<Inspection | null>(null)
let discoveryGeneration = 0
let reportGeneration = 0
let toolGeneration = 0
let discoveryAbort: AbortController | null = null
let reportAbort: AbortController | null = null
let toolAbort: AbortController | null = null
const canSearch = computed(() => !!ws.user.value && !!ws.selected.value && ws.connectionReady.value)
const needs = computed(() => !ws.user.value ? { title: 'See how people find your website.', body: 'Sign in, select a website, and connect Google to review your search performance.', label: 'Sign in', to: '/connections' } : !ws.selected.value ? { title: 'Start with a website.', body: 'Add the domain you manage to connect its Google Search data.', label: 'Add a website', to: '/websites' } : null)
const summary = computed(() => report.value?.summary.rows?.[0])
const metrics = computed(() => [
  { label: 'Search clicks', value: summary.value?.clicks?.toLocaleString() ?? '0', icon: 'i-lucide-mouse-pointer-2', help: 'Clicks from Google web search results.' },
  { label: 'Impressions', value: summary.value?.impressions?.toLocaleString() ?? '0', icon: 'i-lucide-eye', help: 'Appearances in Google web search results.' },
  { label: 'Click-through rate', value: `${((summary.value?.ctr ?? 0) * 100).toFixed(1)}%`, icon: 'i-lucide-percent', help: 'Clicks divided by impressions, from the aggregate report.' },
  { label: 'Average position', value: summary.value?.impressions ? summary.value.position.toFixed(1) : '—', icon: 'i-lucide-list-ordered', help: 'Average topmost search position. A lower value is better.' },
])
const daily = computed<GoogleReport>(() => ({
  metricHeaders: [{ name: 'clicks' }, { name: 'impressions' }],
  rows: [...(report.value?.daily.rows ?? [])].sort((a, b) => (a.keys?.[0] ?? '').localeCompare(b.keys?.[0] ?? '')).map(row => ({ dimensionValues: [{ value: (row.keys?.[0] ?? '').replaceAll('-', '') }], metricValues: [{ value: String(row.clicks) }, { value: String(row.impressions) }] })),
}))
const tables = computed(() => [{ title: 'Search queries', label: 'Query', rows: report.value?.queries.rows ?? [], pages: false }, { title: 'Search landing pages', label: 'Page · select to inspect', rows: report.value?.pages.rows ?? [], pages: true }])
const indexStatus = computed(() => inspection.value?.inspectionResult?.indexStatusResult)
const inspectionLink = computed(() => {
  try { const url = new URL(inspection.value?.inspectionResult?.inspectionResultLink ?? ''); return url.protocol === 'https:' && url.hostname === 'search.google.com' ? url.href : undefined } catch { return undefined }
})
function resetTools() { toolGeneration++; toolAbort?.abort(); toolBusy.value = false; toolError.value = ''; inspection.value = null; }
watch(pageUrl, resetTools)
watch(property, () => { pageUrl.value = ''; resetTools() })
async function discover() {
  clearTimeout(discoveryTimer); clearTimeout(reportTimer)
  const current = ++discoveryGeneration
  discoveryAbort?.abort(); discoveryAbort = new AbortController()
  properties.value = []; property.value = ''; report.value = null; sync.value = null; propertySync.value = null; discoveryError.value = ''; discovering.value = false
  pageUrl.value = ''; resetTools()
  if (!canSearch.value) return
  discovering.value = true
  try {
    const data = await ws.request<{ properties: SearchProperty[]; sync?: SyncStatus } | PendingReport>(`/api/websites/${ws.selectedId.value}/search/properties`, { method: 'POST', body: {}, signal: discoveryAbort.signal })
    if (current !== discoveryGeneration) return
    propertySync.value = data.sync ?? null
    if ('code' in data) {
      if (data.sync.connection_status === 'connected') discoveryTimer = setTimeout(() => { void discover() }, 10000)
      return
    }
    properties.value = data.properties
    property.value = data.properties.find(p => p.siteUrl === `sc-domain:${ws.selected.value?.fqdn}`)?.siteUrl ?? data.properties[0]?.siteUrl ?? ''
  } catch (cause) { if (current === discoveryGeneration) discoveryError.value = failureMessage(cause) }
  finally { if (current === discoveryGeneration) discovering.value = false }
}
async function load(poll = false) {
  clearTimeout(reportTimer)
  const current = ++reportGeneration
  reportAbort?.abort(); reportAbort = new AbortController()
  if (!poll) { report.value = null; sync.value = null }
  error.value = ''; busy.value = false
  if (!canSearch.value || !property.value || !validDateRange(start.value, end.value)) return
  busy.value = true
  try {
    const data = await ws.request<SearchReport | PendingReport>(`/api/websites/${ws.selectedId.value}/search/dashboard`, { method: 'POST', body: { site_url: property.value, start_date: start.value, end_date: end.value }, signal: reportAbort.signal })
    if (current === reportGeneration) {
      sync.value = data.sync ?? null
      if (!('code' in data)) report.value = data
      if (data.sync?.connection_status === 'connected') reportTimer = setTimeout(() => { void load(true) }, 'code' in data ? 10000 : 60000)
    }
  } catch (cause) { if (current === reportGeneration) error.value = failureMessage(cause) }
  finally { if (current === reportGeneration) busy.value = false }
}
function choosePage(row: SearchRow) { pageUrl.value = row.keys?.[0] ?? ''; document.getElementById('inspect-url')?.focus() }
function displayPage(value: string) { try { const url = new URL(value); return url.pathname + url.search } catch { return value } }
function time(value?: string) { if (!value) return 'Not reported'; const date = new Date(value); return Number.isNaN(+date) ? value : date.toLocaleString() }
async function inspectUrl() {
  resetTools()
  const current = toolGeneration
  toolAbort = new AbortController(); toolBusy.value = true
  try {
    const data = await ws.request<Inspection>(`/api/websites/${ws.selectedId.value}/search/inspect`, { method: 'POST', body: { site_url: property.value, url: pageUrl.value }, signal: toolAbort.signal })
    if (current === toolGeneration) inspection.value = data
  } catch (cause) { if (current === toolGeneration) toolError.value = failureMessage(cause) }
  finally { if (current === toolGeneration) toolBusy.value = false }
}

watch(() => [ws.user.value?.id, ws.selectedId.value, canSearch.value], () => { void discover() }, { immediate: true })
watch(() => [property.value, start.value, end.value, ws.user.value?.id, ws.selectedId.value, canSearch.value], () => { void load() }, { immediate: true })
onBeforeUnmount(() => { clearTimeout(discoveryTimer); clearTimeout(reportTimer); discoveryGeneration++; reportGeneration++; discoveryAbort?.abort(); reportAbort?.abort(); resetTools() })
</script>

<template>
  <section class="search-workspace" aria-labelledby="search-heading">
    <div class="search-section-heading"><div><h2 id="search-heading">Google Search performance</h2><p>How people discover this website in Google.</p></div><label v-if="canSearch" class="search-property">Search Console property<select v-model="property" :disabled="discovering || !properties.length"><option v-if="!properties.length" value="">{{ discovering ? 'Finding properties…' : 'No matching property' }}</option><option v-for="item in properties" :key="item.siteUrl" :value="item.siteUrl">{{ item.siteUrl }}</option></select></label><button v-if="property" class="refresh-control" :disabled="busy" @click="load()"><UIcon name="i-lucide-refresh-cw" /><span>Refresh search</span></button></div>
    <p v-if="discoveryError" role="alert" class="form-error">{{ discoveryError }} <button @click="discover">Retry property lookup</button><NuxtLink to="/connections">Manage access</NuxtLink></p>
    <p v-if="error" role="alert" class="form-error">{{ error }} <button @click="load()">Retry search</button><NuxtLink to="/connections">Manage access</NuxtLink></p>
    <div class="traffic-layout" :aria-busy="busy || discovering">
      <section class="report-panel traffic-panel"><header><h3>Search over time</h3><label class="sr-only" for="search-metric">Search chart metric</label><select id="search-metric" v-model="selectedMetric" :disabled="!report"><option value="clicks">Clicks</option><option value="impressions">Impressions</option></select></header>
        <TrafficChart v-if="report?.daily.rows?.length" :report="daily" :selected-metric="selectedMetric" :start="start" :end="end" />
        <div v-else class="chart-empty" aria-live="polite"><template v-if="busy || discovering"><UIcon name="i-lucide-loader-circle" class="loading-spin" /><h3>{{ discovering ? 'Finding your Search Console properties…' : 'Reading your search performance…' }}</h3><p>Reports use finalized Google web search data.</p></template><template v-else-if="needs"><UIcon name="i-lucide-search" /><h3>{{ needs.title }}</h3><p>{{ needs.body }}</p><UButton :to="needs.to" trailing-icon="i-lucide-arrow-right">{{ needs.label }}</UButton></template><template v-else-if="discoveryError || error"><UIcon name="i-lucide-cloud-off" /><h3>Search data could not load.</h3><p>Use the retry action above or review your Google access.</p></template><template v-else-if="propertySync?.state === 'pending' || sync?.state === 'pending'"><UIcon name="i-lucide-clock" /><h3>Waiting for the first sync.</h3><p>Saved search data will appear here automatically.</p></template><template v-else-if="!property"><UIcon name="i-lucide-link" /><h3>No matching Search Console property.</h3><p>Add and verify this exact domain or a URL-prefix property in Search Console, then refresh your properties.</p><UButton variant="outline" color="neutral" @click="discover">Refresh properties</UButton></template><template v-else><UIcon name="i-lucide-search" /><h3>No finalized search data in this period.</h3><p>Recent days may not be ready yet. Try an earlier or wider date range.</p></template></div>
      </section>
      <div class="summary-stack" aria-label="Google Search summary"><div v-for="item in metrics" :key="item.label" class="summary-panel"><UIcon :name="item.icon" /><div><span :title="item.help">{{ item.label }}</span><strong>{{ report ? item.value : '—' }}</strong></div></div></div>
    </div>
    <ReportSyncNotice :sync="sync ?? propertySync" />
    <p class="report-caption">Google Search Console · Web search · Finalized data · Pacific Time<span>Selected hostname only. Queries may omit anonymized searches; ranked tables show up to 10 results. Missing days mean no returned data, not confirmed zero activity.</span></p>
    <div class="search-rankings">
      <section v-for="table in tables" :key="table.title" class="report-panel search-table"><header><h3>{{ table.title }}</h3></header><div v-if="table.rows.length" class="table-scroll"><table><caption class="sr-only">{{ table.title }} for the selected date range</caption><thead><tr><th scope="col">{{ table.label }}</th><th scope="col" class="numeric">Clicks</th><th scope="col" class="numeric">Impressions</th><th scope="col" class="numeric">CTR</th><th scope="col" class="numeric">Position</th></tr></thead><tbody><tr v-for="(row, i) in table.rows" :key="i"><td class="search-dimension"><button v-if="table.pages" class="search-page-link" :title="row.keys?.[0]" @click="choosePage(row)">{{ displayPage(row.keys?.[0] ?? '') }}<UIcon name="i-lucide-arrow-down-right" /></button><span v-else :title="row.keys?.[0]">{{ row.keys?.[0] }}</span></td><td class="numeric">{{ row.clicks.toLocaleString() }}</td><td class="numeric">{{ row.impressions.toLocaleString() }}</td><td class="numeric">{{ (row.ctr * 100).toFixed(1) }}%</td><td class="numeric">{{ row.position.toFixed(1) }}</td></tr></tbody></table></div><p v-else class="search-table-empty">{{ !report ? 'Connect a property to load this report.' : 'No rows returned for this period.' }}</p></section>
    </div>
    <section class="report-panel url-workbench" aria-labelledby="url-heading">
      <header><div><h3 id="url-heading">Understand a URL</h3><p>Check Google’s indexed version of a page, including crawl status and canonical URL.</p></div></header>
      <form class="url-inspect-form" @submit.prevent="inspectUrl"><label for="inspect-url">Page URL<input id="inspect-url" v-model="pageUrl" type="url" required maxlength="2048" :placeholder="`https://${ws.selected.value?.fqdn || 'example.com'}/`" :disabled="!property"></label><UButton type="submit" icon="i-lucide-scan-search" :loading="toolBusy" :disabled="!property || !pageUrl || toolBusy">Inspect URL</UButton></form>
      <p v-if="!property" class="tool-guidance">Select a Search Console property above to use URL tools.</p>
      <p v-if="toolError" class="form-error" role="alert">{{ toolError }}</p>
      <div v-if="inspection" class="inspection-result" aria-live="polite"><h4>{{ indexStatus?.coverageState || 'Inspection returned no index status' }}</h4><dl><div><dt>Verdict</dt><dd>{{ indexStatus?.verdict || 'Not reported' }}</dd></div><div><dt>Last crawl</dt><dd>{{ indexStatus?.lastCrawlTime ? time(indexStatus.lastCrawlTime) : 'Not reported' }}</dd></div><div><dt>Robots.txt</dt><dd>{{ indexStatus?.robotsTxtState || 'Not reported' }}</dd></div><div><dt>Indexing allowed</dt><dd>{{ indexStatus?.indexingState || 'Not reported' }}</dd></div><div><dt>Page fetch</dt><dd>{{ indexStatus?.pageFetchState || 'Not reported' }}</dd></div><div><dt>Google canonical</dt><dd>{{ indexStatus?.googleCanonical || 'Not reported' }}</dd></div></dl><a v-if="inspectionLink" :href="inspectionLink" target="_blank" rel="noopener noreferrer" class="settings-link">Open inspection in Search Console <UIcon name="i-lucide-external-link" /></a></div>
      <p class="tool-guidance">URL Inspection is read-only. It describes Google’s indexed version and does not run a live test or request indexing.</p>
    </section>
  </section>
</template>
