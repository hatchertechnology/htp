<script setup lang="ts">
import type { ConversionData } from '../../shared/types/insights'
import { metric } from '#shared/utils/analytics'
const ws = useWorkspace()
const { start, end } = useReportRange()
const { saved, error, busy, load } = useInsight<ConversionData>('conversions', () => ws.selected.value?.ga4_property_id ?? null)
const data = computed(() => saved.value?.data)
const selectedMetric = ref('keyEvents')
const limited = computed(() => Object.values(data.value ?? {}).some(report => report.metadata?.subjectToThresholding || report.metadata?.dataLossFromOtherRow || report.metadata?.samplingMetadatas?.length))
const total = computed(() => data.value?.summary)
function money(value: number) {
  const currency = total.value?.metadata?.currencyCode
  return currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value) : value.toLocaleString()
}
</script>
<template>
  <section class="insight-section" aria-labelledby="conversions-title">
    <div class="analytics-section-heading"><div><h2 id="conversions-title">Conversions &amp; revenue</h2><p>Key events and business outcomes · Google Analytics</p></div><button v-if="ws.selected.value?.ga4_property_id" class="refresh-control" :disabled="busy" @click="load()">Reload saved conversions</button></div>
    <p v-if="error" role="alert" class="form-error">{{ error }} <button @click="load()">Try again</button></p>
    <ReportSyncNotice :sync="saved?.sync" />
    <p v-if="!ws.selected.value?.ga4_property_id" class="compact-empty">Link a GA4 property under Websites to collect conversions.</p>
    <template v-else>
      <dl class="insight-totals"><div><dt>Key events</dt><dd>{{ data ? metric(total, 'keyEvents').toLocaleString() : '—' }}</dd></div><div><dt>Session conversion rate</dt><dd>{{ data ? `${(metric(total, 'sessionKeyEventRate') * 100).toFixed(1)}%` : '—' }}</dd></div><div><dt>Revenue{{ total?.metadata?.currencyCode ? ` (${total.metadata.currencyCode})` : '' }}</dt><dd>{{ data ? money(metric(total, 'totalRevenue')) : '—' }}</dd></div></dl>
      <p v-if="limited" class="form-notice">Google reports sampling, privacy thresholds, or grouped rows. Some counts may be withheld.</p>
      <p class="report-caption">Conversions use GA4 key events. Revenue and outcomes depend on your configured tracking; zero does not establish that tracking is complete. Ranked reports show up to 100 rows; totals come directly from Google’s separate aggregate report.</p>
      <section class="report-panel traffic-panel"><header><h3>Outcomes over time</h3><label>Measure <select v-model="selectedMetric"><option value="keyEvents">Key events</option><option value="sessionKeyEventRate">Session conversion rate</option><option value="totalRevenue">Revenue</option></select></label></header><TrafficChart v-if="data?.daily.rows?.length" :report="data.daily" :selected-metric="selectedMetric" :start="start" :end="end" /><p v-else class="compact-empty">{{ busy || saved?.sync.state === 'pending' ? 'Waiting for the saved conversion report.' : 'No conversion data for this period.' }}</p></section>
      <div class="detail-layout conversion-details"><ConversionTable title="Landing pages by conversions" :report="data?.pages" dimension="Landing page" :currency="total?.metadata?.currencyCode" /><ConversionTable title="Channels by conversions" :report="data?.channels" dimension="Channel" :currency="total?.metadata?.currencyCode" /><RankedReport title="Key events" :report="data?.events" dimension="Event" metric-name="keyEvents" metric-label="Key events" :total="metric(total, 'keyEvents')" :waiting="!data" /></div>
    </template>
  </section>
</template>
