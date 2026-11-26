<script setup lang="ts">
import { FAMILY_KEYS, panelNotice, sectionView, type PanelLoad } from '#shared/utils/wire2-families'
import { loadEvidenceFamilies } from '#shared/utils/wire2-families-client'
// Read-only. Shows the six per-family evidence sections stored with one saved audit.
// Reading never starts a crawl, collection or analysis. No timestamps are shown here;
// the audit's own time is displayed (in local time) by the run header above.
const props = defineProps<{ websiteId: string; deliveryId: string }>()
const runtime = useRuntimeConfig().public as { apiBaseUrl?: unknown; rolloutEvidenceFamilies?: unknown }
const { accessToken } = useAuth()
const state = ref<PanelLoad>({ kind: 'loading' })
let generation = 0
let controller: AbortController | null = null
async function load() {
  const gen = ++generation
  controller?.abort()
  controller = new AbortController()
  state.value = { kind: 'loading' }
  const result = await loadEvidenceFamilies({ runtime, accessToken, fetcher: (url, options) => $fetch(url, options as never) }, props.websiteId, props.deliveryId, controller.signal)
  if (gen !== generation) return
  state.value = result
}
const notice = computed(() => panelNotice(state.value))
const sections = computed(() => state.value.kind === 'collected' ? FAMILY_KEYS.map(key => sectionView(key, (state.value as Extract<PanelLoad, { kind: 'collected' }>).families.families[key])) : [])
watch(() => [props.websiteId, props.deliveryId], load, { immediate: true })
onBeforeUnmount(() => { generation++; controller?.abort() })
</script>
<template>
  <section class="report-panel evidence-families" aria-labelledby="evidence-families-title" :aria-busy="state.kind === 'loading'">
    <h3 id="evidence-families-title">Evidence families</h3>
    <p class="report-caption">Per-family technical evidence stored with this audit: indexing, integrity, structured data, link graph, duplicates and resources. Read-only; reading it never starts a crawl. A family that could not be determined is shown as unknown or unavailable, never as zero.</p>
    <template v-if="notice.text">
      <p v-if="notice.tone === 'error'" role="alert" class="form-error">{{ notice.text }} <button v-if="state.kind === 'unavailable'" class="refresh-control" type="button" @click="load">Try again</button></p>
      <p v-else-if="notice.tone === 'notice'" role="status" class="form-notice">{{ notice.text }}</p>
      <p v-else role="status" class="compact-empty">{{ notice.text }}</p>
    </template>
    <div v-for="section in sections" :key="section.key" class="evidence-family">
      <h4>{{ section.label }} <span class="report-caption">· {{ section.stateLabel }}</span></h4>
      <p v-if="section.notice" role="status" class="form-notice">{{ section.notice }}</p>
      <dl v-if="section.counts.length" class="evidence-family-counts"><div v-for="count in section.counts" :key="count.label" class="evidence-family-count"><dt>{{ count.label }}</dt><dd>{{ count.value }}</dd></div></dl>
      <ul v-if="section.unknownReasons.length" class="report-caption"><li v-for="reason in section.unknownReasons" :key="reason.code">Unknown for {{ reason.count.toLocaleString() }}: {{ reason.text }}</li></ul>
      <p v-if="section.truncation" role="status" class="report-caption">{{ section.truncation }}</p>
      <div v-if="section.rows.length" class="table-scroll"><table><caption class="sr-only">{{ section.label }} evidence items</caption><thead><tr><th scope="col">Page or resource</th><th scope="col">Kind</th><th scope="col">Outcome</th><th scope="col">Reason</th><th scope="col">Facts</th></tr></thead>
        <tbody><tr v-for="(row, index) in section.rows" :key="index"><td>{{ row.locator }}</td><td>{{ row.kind }}</td><td>{{ row.outcome }}</td><td>{{ row.reason || '—' }}</td><td :title="row.facts">{{ row.facts || '—' }}</td></tr></tbody></table></div>
      <p v-else-if="section.stateLabel !== 'Unavailable' && !section.truncation" class="report-caption">No items were recorded for this family.</p>
    </div>
  </section>
</template>
<style scoped>
.evidence-family { margin-top: 16px; }
.evidence-family-counts { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px 12px; margin: 8px 0; font-variant-numeric: tabular-nums; }
.evidence-family-counts dt { color: var(--muted); font-size: 11px; }
.evidence-family-counts dd { font-size: 14px; font-weight: 600; }
@media (max-width: 650px) { .evidence-family-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
