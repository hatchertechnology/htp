<script setup lang="ts">
import type { GoogleReport } from '../../shared/types/dashboard'
import { metric } from '#shared/utils/analytics'
const props = defineProps<{ report: GoogleReport; selectedMetric: string; start: string; end: string }>()
const svg = ref<SVGSVGElement | null>(null)
const width = ref(920)
const height = ref(300)
let resize: ResizeObserver | undefined
onMounted(() => {
  resize = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width > 0) { width.value = entry.contentRect.width; height.value = Math.max(160, entry.contentRect.height) } })
  if (svg.value) resize.observe(svg.value)
})
onBeforeUnmount(() => resize?.disconnect())
const right = computed(() => width.value - 14)
const bottom = computed(() => height.value - 34)
const rows = computed(() => props.report.rows ?? [])
const maximum = computed(() => Math.max(1, ...rows.value.map((_, index) => metric(props.report, props.selectedMetric, index))))
const points = computed(() => rows.value.map((row, i) => {
  const d = row.dimensionValues?.[0]?.value ?? ''
  const time = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`)
  const total = Math.max(86400_000, Date.parse(props.end) - Date.parse(props.start))
  return { x: 44 + ((time - Date.parse(props.start)) / total) * (right.value - 44), y: bottom.value - metric(props.report, props.selectedMetric, i) / maximum.value * (bottom.value - 18), value: metric(props.report, props.selectedMetric, i), date: `${d.slice(4, 6)}/${d.slice(6, 8)}` }
}))
const path = computed(() => points.value.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '))
const area = computed(() => points.value.length ? `${path.value} L ${points.value.at(-1)!.x} ${bottom.value} L ${points.value[0]!.x} ${bottom.value} Z` : '')
const ticks = computed(() => [0, 1, 2, 3, 4].map(i => ({ value: maximum.value * (4 - i) / 4, y: 18 + i * (bottom.value - 18) / 4 })))
function dateText(value: string) { return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value + 'T12:00:00Z')) }
</script>
<template>
  <div class="traffic-chart">
    <svg ref="svg" :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="`${selectedMetric} by day from ${start} through ${end}. Expand Daily data below for exact values.`">
      <g v-for="tick in ticks" :key="tick.y"><line x1="44" :x2="right" :y1="tick.y" :y2="tick.y" class="chart-grid" /><text x="34" :y="tick.y + 4" text-anchor="end" class="chart-label">{{ Math.round(tick.value).toLocaleString() }}</text></g>
      <path v-if="area" :d="area" class="chart-area" /><path v-if="path" :d="path" class="chart-line" />
      <circle v-for="p in points" :key="p.date" :cx="p.x" :cy="p.y" r="3.6" class="chart-point"><title>{{ p.date }}: {{ p.value }}</title></circle>
      <text x="44" :y="height - 8" class="chart-label">{{ dateText(start) }}</text><text :x="right" :y="height - 8" text-anchor="end" class="chart-label">{{ dateText(end) }}</text>
    </svg>
    <details class="daily-data"><summary>Daily data</summary><div class="table-scroll"><table><caption class="sr-only">Daily {{ selectedMetric }}</caption><thead><tr><th scope="col">Date</th><th scope="col" class="numeric">{{ selectedMetric }}</th></tr></thead><tbody><tr v-for="p in points" :key="p.date"><td>{{ p.date }}</td><td class="numeric">{{ p.value.toLocaleString() }}</td></tr></tbody></table></div></details>
  </div>
</template>
