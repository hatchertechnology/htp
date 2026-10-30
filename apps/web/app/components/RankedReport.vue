<script setup lang="ts">
import type { GoogleReport } from '../../shared/types/dashboard'
import { metric } from '#shared/utils/analytics'
const props = defineProps<{ title: string; report?: GoogleReport; dimension: string; metricName: string; metricLabel: string; total: number; waiting?: boolean }>()
</script>
<template>
  <section class="report-panel ranked-panel"><header><h2>{{ title }}</h2><span class="table-measure">{{ metricLabel }}</span></header>
    <div v-if="report?.rows?.length" class="table-scroll"><table><caption class="sr-only">{{ title }} by {{ metricLabel }}</caption><thead><tr><th scope="col">{{ dimension }}</th><th scope="col" class="numeric">{{ metricLabel }}</th><th scope="col" class="numeric">Share</th></tr></thead><tbody><tr v-for="(row, index) in report.rows" :key="index"><td class="dimension-label" :title="row.dimensionValues?.[0]?.value">{{ row.dimensionValues?.[0]?.value || '(not set)' }}</td><td class="numeric">{{ metric(report, metricName, index).toLocaleString() }}</td><td class="numeric muted">{{ total ? (metric(report, metricName, index) / total * 100).toFixed(1) : '0.0' }}%</td></tr></tbody></table></div>
    <p v-else class="compact-empty">{{ waiting ? 'Your report will appear here.' : 'No data for this period.' }}</p>
  </section>
</template>
