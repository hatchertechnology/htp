<script setup lang="ts">
import type { AuditRun } from '../../shared/types/seosmith'
import { auditPoints, auditMetricLabels, comparable, type AuditMetric } from '#shared/utils/seosmith'
const props = defineProps<{ runs: AuditRun[]; metric: AuditMetric; selectedId?: string }>()
const emit = defineEmits<{ select: [id: string] }>()
const svg = ref<SVGSVGElement | null>(null), width = ref(900)
let observer: ResizeObserver | undefined
onMounted(() => { observer = new ResizeObserver(([entry]) => { if (entry) width.value = Math.max(280, entry.contentRect.width) }); if (svg.value) observer.observe(svg.value) })
onBeforeUnmount(() => observer?.disconnect())
const points = computed(() => auditPoints(props.runs, props.metric))
const maximum = computed(() => Math.max(1, ...points.value.map(p => p.value ?? 0)))
const first = computed(() => points.value[0]?.time ?? 0), last = computed(() => points.value.at(-1)?.time ?? first.value)
function x(time: number) { return last.value === first.value ? width.value / 2 : 45 + (time - first.value) / (last.value - first.value) * (width.value - 65) }
function y(value: number) { return 208 - value / maximum.value * 180 }
const path = computed(() => points.value.map((p, i) => p.value === null ? '' : `${i && points.value[i - 1]?.value !== null && comparable(points.value[i - 1]!.run, p.run) ? 'L' : 'M'} ${x(p.time)} ${y(p.value)}`).join(' '))
function stamp(time: number) { return new Date(time).toISOString().slice(5, 16).replace('T', ' ') }
</script>
<template>
  <div class="seo-trend">
    <svg ref="svg" :viewBox="`0 0 ${width} 260`" role="group" :aria-label="`${auditMetricLabels[metric]} by scan time. Select a point to inspect a run.`">
      <template v-for="fraction in [0, .5, 1]" :key="fraction"><line x1="45" :x2="width - 20" :y1="y(maximum * fraction)" :y2="y(maximum * fraction)" stroke="var(--border)" /><text x="36" :y="y(maximum * fraction) + 4" text-anchor="end">{{ (maximum * fraction).toLocaleString(undefined, { maximumFractionDigits: 1 }) }}</text></template>
      <path :d="path" fill="none" stroke="var(--navy, #182c3d)" stroke-width="2" />
      <template v-for="point in points" :key="point.run.delivery_id"><circle v-if="point.value !== null" :cx="x(point.time)" :cy="y(point.value)" :r="point.run.delivery_id === selectedId ? 7 : 5" :fill="point.run.summary.coverage_complete ? '#182c3d' : '#fff'" :stroke="point.run.summary.coverage_complete ? '#182c3d' : '#b94d28'" stroke-width="2" role="button" tabindex="0" :aria-label="`${stamp(point.time)} UTC: ${point.value.toLocaleString()} ${auditMetricLabels[metric]}, ${point.run.summary.outcome}`" :aria-pressed="point.run.delivery_id === selectedId" @click="emit('select', point.run.delivery_id)" @keydown.enter.prevent="emit('select', point.run.delivery_id)" @keydown.space.prevent="emit('select', point.run.delivery_id)"><title>{{ new Date(point.time).toISOString() }} · {{ point.value }} · {{ point.run.summary.outcome }}</title></circle></template>
      <text v-if="points.length" x="45" y="240">{{ stamp(first) }}</text><text v-if="points.length > 1" :x="width - 20" y="240" text-anchor="end">{{ stamp(last) }}</text>
    </svg>
    <p class="report-caption">Scan time (UTC) · Filled: complete coverage · Hollow: partial or failed.<span>Lines connect only complete runs with matching crawl settings, engine, and ruleset. Each point is one run; no daily averaging. Runs without scan timestamps remain in history but are not plotted.</span></p>
  </div>
</template>
