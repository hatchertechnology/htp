<script setup lang="ts">
import type { GoogleReport } from '../../shared/types/dashboard'
import { metric } from '#shared/utils/analytics'
const props = defineProps<{ title: string; dimension: string; report?: GoogleReport; currency?: string }>()
const expanded = ref(false)
const rows = computed(() => expanded.value ? props.report?.rows ?? [] : (props.report?.rows ?? []).slice(0, 10))
function value(name: string, index: number) {
  if (!props.report?.metricHeaders?.some(header => header.name === name)) return '—'
  const number = metric(props.report, name, index)
  if (name === 'sessionKeyEventRate') return `${(number * 100).toFixed(1)}%`
  if (name === 'totalRevenue' && props.currency) return new Intl.NumberFormat(undefined, { style: 'currency', currency: props.currency }).format(number)
  return number.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
</script>
<template>
  <section class="report-panel conversion-table">
    <header><h3>{{ title }}</h3></header>
    <div v-if="report?.rows?.length" class="table-scroll"><table>
      <caption class="sr-only">{{ title }} for the selected date range</caption>
      <thead><tr><th scope="col">{{ dimension }}</th><th scope="col">Sessions</th><th scope="col">Key events</th><th scope="col">Conversion rate</th><th scope="col">Revenue{{ currency ? ` (${currency})` : '' }}</th></tr></thead>
      <tbody><tr v-for="(row, index) in rows" :key="index"><th scope="row" class="conversion-dimension">{{ row.dimensionValues?.[0]?.value || '(not set)' }}</th><td>{{ value('sessions', index) }}</td><td>{{ value('keyEvents', index) }}</td><td>{{ value('sessionKeyEventRate', index) }}</td><td>{{ value('totalRevenue', index) }}</td></tr></tbody>
    </table></div>
    <p v-else class="compact-empty">{{ report ? 'No conversion data for this period.' : 'Waiting for the saved conversion report.' }}</p>
    <button v-if="(report?.rows?.length ?? 0) > 10" class="refresh-control" @click="expanded = !expanded">{{ expanded ? 'Show top 10' : `Show all ${report?.rows?.length} rows` }}</button>
  </section>
</template>
