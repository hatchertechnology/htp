<script setup lang="ts">
import type { DashboardReport } from '../../shared/types/dashboard'
import type { SearchReport } from '../../shared/types/search'
import { timelineCommits, timelineDays, timelinePath, type OnsiteMetric, type SearchMetric } from '#shared/utils/performance-timeline'
const props = defineProps<{ search: SearchReport | null; onsite: DashboardReport | null; searchLoading: boolean; onsiteLoading: boolean; searchError: string; onsiteError: string }>()
const ws = useWorkspace()
const { start, end, includeToday } = useReportRange()
const { history, busy: commitBusy, error: commitError, load: reloadCommits } = useRepositoryHistory(() => ws.selectedId.value, () => start.value, () => end.value, () => true, true, true)
const searchMetric = ref<SearchMetric>('clicks')
const onsiteMetric = ref<OnsiteMetric>('sessions')
const searchLabels: Record<SearchMetric, string> = { clicks: 'Search clicks', impressions: 'Search impressions', ctr: 'Search CTR', position: 'Average search position' }
const onsiteLabels: Record<OnsiteMetric, string> = { sessions: 'Sessions', activeUsers: 'Active users', screenPageViews: 'Page views', engagementRate: 'Engagement rate' }
const days = computed(() => timelineDays(start.value, end.value, props.search, props.onsite?.report.daily, searchMetric.value, onsiteMetric.value))
const commits = computed(() => timelineCommits(history.value?.commits ?? [], history.value?.repository, start.value, end.value))
const selectedSha = ref('')
const selected = computed(() => commits.value.find(commit => commit.sha === selectedSha.value))
watch(() => [ws.user.value?.id, ws.selectedId.value, start.value, end.value], () => { selectedSha.value = '' }, { flush: 'sync' })
watch(commits, value => { if (!value.some(commit => commit.sha === selectedSha.value)) selectedSha.value = '' })
const wrapper = ref<HTMLDivElement | null>(null)
const width = ref(1000)
const height = computed(() => width.value < 600 ? 290 : 340)
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width > 0) width.value = entry.contentRect.width })
  if (wrapper.value) observer.observe(wrapper.value)
})
watch(wrapper, (element, previous) => {
  if (previous) observer?.unobserve(previous)
  if (element) observer?.observe(element)
}, { flush: 'post' })
onBeforeUnmount(() => observer?.disconnect())
const left = 54
const right = computed(() => Math.max(left + 100, width.value - 54))
const top = 24
const bottom = computed(() => height.value - 36)
const span = computed(() => Math.max(86400_000, Date.parse(end.value) + 86400_000 - Date.parse(start.value)))
function x(time: number) { return left + (time - Date.parse(start.value)) / span.value * (right.value - left) }
const searchMax = computed(() => Math.max(...days.value.map(day => day.search ?? 0), 0) || 1)
const onsiteMax = computed(() => Math.max(...days.value.map(day => day.onsite ?? 0), 0) || 1)
function y(value: number, max: number) { return bottom.value - value / max * (bottom.value - top) }
const searchPath = computed(() => timelinePath(days.value, 'search', x, value => y(value, searchMax.value)))
const onsitePath = computed(() => timelinePath(days.value, 'onsite', x, value => y(value, onsiteMax.value)))
const ticks = computed(() => [0, 1, 2, 3, 4].map(i => ({ fraction: i / 4, y: bottom.value - i / 4 * (bottom.value - top) })))
const hasData = computed(() => days.value.some(day => day.search !== null || day.onsite !== null))
const commitCounts = computed(() => {
  const result: Record<string, number> = {}
  for (const commit of commits.value) { const day = commit.committed_at.slice(0, 10); result[day] = (result[day] ?? 0) + 1 }
  return result
})
const selectedDay = computed(() => days.value.find(day => day.date === selected.value?.committed_at.slice(0, 10)))
function format(value: number | null | undefined, metric: string) {
  if (value === undefined || value === null) return '—'
  return ['ctr', 'engagementRate'].includes(metric) ? `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : value.toLocaleString(undefined, { maximumFractionDigits: metric === 'position' ? 1 : 2 })
}
function tickLabel(value: number, metric: string) {
  return !['ctr', 'engagementRate'].includes(metric) && value >= 1000 ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : format(value, metric)
}
function date(value: string) { return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`)) }
function commitLabel(commit: typeof commits.value[number]) { return `${commit.committed_at.replace('T', ' ').slice(0, 19)} UTC · ${commit.sha.slice(0, 7)} · ${commit.message.split('\n')[0]}` }
</script>
<template>
  <section class="combined-performance" aria-labelledby="combined-title" :aria-busy="searchLoading || onsiteLoading || commitBusy">
    <div class="analytics-section-heading"><div><h2 id="combined-title">Search, visitors &amp; code changes</h2><p>Compare daily website performance with changes on the primary branch</p></div><button class="refresh-control" @click="includeToday">Include today</button></div>
    <div class="report-panel combined-panel">
      <div class="combined-controls">
        <label class="combined-search">Google Search · left axis<select v-model="searchMetric" aria-label="Combined Search metric"><option v-for="(label, name) in searchLabels" :key="name" :value="name">{{ label }}</option></select></label>
        <label class="combined-onsite">Onsite · right axis<select v-model="onsiteMetric" aria-label="Combined Onsite metric"><option v-for="(label, name) in onsiteLabels" :key="name" :value="name">{{ label }}</option></select></label>
        <span class="combined-commit-key">Vertical lines · {{ commits.length }} commits<span v-if="history?.repository"> · {{ history.repository.branch || 'default branch' }}</span></span>
      </div>
      <p v-if="searchError || onsiteError" class="form-error" role="alert">{{ searchError ? `Search: ${searchError}` : '' }} {{ onsiteError ? `Onsite: ${onsiteError}` : '' }}</p>
      <p v-if="commitError" class="form-error" role="alert">Commit markers: {{ commitError }} <button @click="reloadCommits()">Retry commit history</button></p>
      <p v-if="commitBusy" class="report-caption" role="status">Reading all saved commits in this date range…</p>
      <p v-if="!ws.user.value || !ws.selectedId.value" class="compact-empty">Sign in and select a website to compare saved performance reports.</p>
      <template v-else>
        <div ref="wrapper" class="combined-chart">
          <svg :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="`${searchLabels[searchMetric]} on the left axis and ${onsiteLabels[onsiteMetric]} on the right axis, from ${start} to ${end}, with ${commits.length} primary-branch commit markers. Use the commit selector or daily data below for details.`">
            <g v-for="tick in ticks" :key="tick.fraction"><line :x1="left" :x2="right" :y1="tick.y" :y2="tick.y" class="chart-grid" /><text :x="left - 8" :y="tick.y + 4" text-anchor="end" class="chart-label combined-search-label">{{ tickLabel(tick.fraction * searchMax, searchMetric) }}</text><text :x="right + 8" :y="tick.y + 4" class="chart-label combined-onsite-label">{{ tickLabel(tick.fraction * onsiteMax, onsiteMetric) }}</text></g>
            <g v-for="commit in commits" :key="commit.sha" class="combined-commit" :class="{ 'is-selected': selectedSha === commit.sha }" @click="selectedSha = commit.sha">
              <line :x1="x(Date.parse(commit.committed_at))" :x2="x(Date.parse(commit.committed_at))" :y1="top" :y2="bottom" class="combined-commit-marker" />
              <line :x1="x(Date.parse(commit.committed_at))" :x2="x(Date.parse(commit.committed_at))" :y1="top" :y2="bottom" class="combined-commit-hit"><title>{{ commitLabel(commit) }}</title></line>
            </g>
            <path v-if="searchPath" :d="searchPath" class="chart-line combined-search-line" /><path v-if="onsitePath" :d="onsitePath" class="chart-line combined-onsite-line" />
            <g v-for="day in days" :key="day.date"><circle v-if="day.search !== null" :cx="x(day.time)" :cy="y(day.search, searchMax)" r="3" class="combined-search-point"><title>{{ day.date }} · {{ searchLabels[searchMetric] }}: {{ format(day.search, searchMetric) }}</title></circle><circle v-if="day.onsite !== null" :cx="x(day.time)" :cy="y(day.onsite, onsiteMax)" r="3" class="combined-onsite-point"><title>{{ day.date }} · {{ onsiteLabels[onsiteMetric] }}: {{ format(day.onsite, onsiteMetric) }}</title></circle></g>
            <text :x="left" :y="height - 10" class="chart-label">{{ date(start) }}</text><text :x="right" :y="height - 10" text-anchor="end" class="chart-label">{{ date(end) }}</text>
            <text v-if="!hasData" :x="width / 2" :y="height / 2" text-anchor="middle" class="chart-label">{{ searchLoading || onsiteLoading ? 'Reading saved reports…' : 'No saved performance data for these dates.' }}</text>
          </svg>
        </div>
        <p v-if="!searchLoading && !onsiteLoading && hasData && days.some(day => day.search === null || day.onsite === null)" class="report-caption">Gaps mean no returned value, rather than confirmed zero activity.</p>
        <div v-if="commits.length" class="combined-commit-inspector">
          <label for="combined-commit">Inspect a commit<select id="combined-commit" v-model="selectedSha"><option value="">Select a vertical line or choose a commit</option><option v-for="commit in commits" :key="commit.sha" :value="commit.sha">{{ commitLabel(commit) }}</option></select></label>
          <div v-if="selected" class="combined-commit-detail" aria-live="polite"><a :href="`${selected.repository_url}/commit/${selected.sha}`" target="_blank" rel="noopener noreferrer">{{ selected.message.split('\n')[0] }} · {{ selected.sha.slice(0, 7) }}</a><p>{{ commitLabel(selected) }} · {{ selected.author || 'Unknown author' }}</p><p>{{ selectedDay?.date }} reporting date: {{ searchLabels[searchMetric] }} {{ format(selectedDay?.search, searchMetric) }} · {{ onsiteLabels[onsiteMetric] }} {{ format(selectedDay?.onsite, onsiteMetric) }}</p></div>
        </div>
        <p v-else-if="!commitBusy && !commitError" class="report-caption">{{ history?.repository ? 'No saved commits on this tracked branch in these dates.' : 'Link a public GitHub repository under Websites to add commit markers.' }} <NuxtLink v-if="!history?.repository" to="/websites">Manage repositories</NuxtLink></p>
        <details class="daily-data combined-daily"><summary>Combined daily data</summary><div class="table-scroll"><table><thead><tr><th scope="col">Reporting date</th><th scope="col">{{ searchLabels[searchMetric] }}</th><th scope="col">{{ onsiteLabels[onsiteMetric] }}</th><th scope="col">Commits (UTC)</th></tr></thead><tbody><tr v-for="day in days" :key="day.date"><td>{{ day.date }}</td><td>{{ format(day.search, searchMetric) }}</td><td>{{ format(day.onsite, onsiteMetric) }}</td><td>{{ commitCounts[day.date] ?? 0 }}</td></tr></tbody></table></div></details>
      </template>
    </div>
    <p class="report-caption">Each series has its own labeled scale. Daily totals use Google Search’s Pacific Time and GA4’s {{ onsite?.report.daily.metadata?.timeZone || onsite?.report.summary.metadata?.timeZone || 'property timezone' }}; those daily windows differ. Commit markers use exact UTC commit times. Commits are repository changes, not confirmed deployments, and correlation does not establish causation.<span v-if="history?.repository?.backfilling">Older Git history is still being collected; markers will fill in as it arrives.</span><span v-if="history?.repository?.last_error">Repository collection has an error. Check Website change history below for details.</span><span v-if="history?.repository && !history.repository.enabled">Repository collection is paused; saved commit markers remain available.</span><span v-if="searchMetric === 'position'">Lower average search position is better.</span></p>
  </section>
</template>
