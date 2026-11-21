<script setup lang="ts">
import { compareIndependent, parseControlledCsv } from '#shared/utils/independent-audit'
useHead({ title: 'Hatch · Independent audit comparisons' })
const ws = useWorkspace(), supabase = useNuxtApp().$supabase
const snapshots = ref<any[]>([]), imports = ref<any[]>([]), selected = ref<any>(null), runs = ref<any[]>([]), run = ref(''), report = ref<any>(null)
const importCursor = ref<any>(null), snapshotCursor = ref<any>(null), runCursor = ref<any>(null)
const source = ref(''), sourceName = ref(''), metadata = ref(''), asserted = ref(false), busy = ref(false), error = ref(''), notice = ref('')
let generation = 0, selectionGeneration = 0
const comparison = computed(() => {
  if (!selected.value || !report.value) return []
  try { return compareIndependent(parseControlledCsv(selected.value.source_text), report.value, asserted.value) } catch { return [] }
})
function download() {
  if (!selected.value) return
  const url = URL.createObjectURL(new Blob([selected.value.source_text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = 'independent-audit.csv'; link.click(); URL.revokeObjectURL(url)
}
async function load() {
  const gen = ++generation, site = ws.selectedId.value
  selectionGeneration++
  importCursor.value = null; snapshotCursor.value = null; runCursor.value = null
  snapshots.value = []; imports.value = []; selected.value = null; runs.value = []; report.value = null; run.value = ''; error.value = ''
  if (!site || !ws.user.value) return
  try {
    const [history, audits, comparisons] = await Promise.all([
      supabase.rpc('independent_audit_history', { p_website_id: site, p_id: null }),
      ws.request<any>(`/api/websites/${site}/seo/audits`),
      supabase.rpc('independent_comparison_history', { p_website_id: site }),
    ])
    if (gen !== generation) return
    if (history.error) throw history.error
    if (comparisons.error) throw comparisons.error
    snapshots.value = comparisons.data?.items || []; snapshotCursor.value = comparisons.data?.next_cursor
    imports.value = history.data?.items || []; importCursor.value = history.data?.next_cursor
    runs.value = audits.items || []; runCursor.value = audits.next_cursor
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
}
async function more(kind: 'imports' | 'snapshots' | 'runs') {
  const gen = generation, site = ws.selectedId.value
  const cursor = kind === 'imports' ? importCursor.value : kind === 'snapshots' ? snapshotCursor.value : runCursor.value
  if (!cursor) return
  try {
    if (kind === 'runs') {
      const result = await ws.request<any>(`/api/websites/${site}/seo/audits`, { query: cursor })
      if (gen === generation) { runs.value.push(...result.items); runCursor.value = result.next_cursor }
    } else {
      const fn = kind === 'imports' ? 'independent_audit_history' : 'independent_comparison_history'
      const result = await supabase.rpc(fn, { p_website_id: site, ...(kind === 'imports' ? { p_id: null } : {}), p_before: cursor.before, p_before_id: cursor.before_id })
      if (result.error) throw result.error
      if (gen !== generation) return
      if (kind === 'imports') { imports.value.push(...result.data.items); importCursor.value = result.data.next_cursor }
      else { snapshots.value.push(...result.data.items); snapshotCursor.value = result.data.next_cursor }
    }
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
}
async function choose(id: string) {
  const gen = generation, selection = ++selectionGeneration, site = ws.selectedId.value
  selected.value = null
  try {
    const result = await supabase.rpc('independent_audit_history', { p_website_id: site, p_id: id })
    if (result.error) throw result.error
    if (gen === generation && selection === selectionGeneration) selected.value = result.data
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
}
async function chooseRun() {
  const gen = generation, site = ws.selectedId.value, id = run.value; report.value = null
  if (!id) return
  try {
    const detail = await ws.request<any>(`/api/websites/${site}/seo/audits/${id}`)
    if (gen === generation && id === run.value) report.value = detail.report
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
}
async function saveComparison() {
  if (!selected.value || !run.value || !report.value || busy.value) return
  const gen = generation; busy.value = true
  try {
    const result = await supabase.rpc('save_independent_comparison', { p_website_id: ws.selectedId.value, p_import_id: selected.value.id, p_delivery_id: run.value, p_asserted: asserted.value })
    if (result.error) throw result.error
    if (gen === generation) { snapshots.value = [result.data, ...snapshots.value]; notice.value = 'Comparison saved.' }
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
  finally { busy.value = false }
}
async function openComparison(item: any) {
  const gen = generation
  asserted.value = item.unmodified_v1_asserted
  await choose(item.import_id)
  if (gen !== generation || selected.value?.id !== item.import_id) return
  run.value = item.delivery_id; await chooseRun()
}
async function fileChanged(event: Event) {
  const gen = generation, file = (event.target as HTMLInputElement).files?.[0]; source.value = ''; sourceName.value = ''
  if (!file) return
  try {
    if (file.size > 4_194_304) throw new Error('Choose a UTF-8 CSV at most 4 MiB.')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())
    parseControlledCsv(text)
    if (gen !== generation) return
    source.value = text; sourceName.value = file.name; error.value = ''
  } catch (cause) { if (gen === generation) { source.value = ''; error.value = failureMessage(cause) } }
}
async function save() {
  if (!ws.selectedId.value || !source.value || busy.value) return
  const site = ws.selectedId.value, gen = generation; busy.value = true; error.value = ''; notice.value = ''
  try {
    parseControlledCsv(source.value)
    const result = await supabase.rpc('import_independent_audit', { p_website_id: site, p_format: 'controlled-csv-v1', p_source: source.value, p_metadata: { filename: sourceName.value, provenance: metadata.value || null } })
    if (result.error) throw result.error
    if (gen !== generation) return
    source.value = ''; metadata.value = ''; sourceName.value = ''; await load(); notice.value = 'Source saved.'
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
  finally { busy.value = false }
}
watch(() => [ws.user.value?.id, ws.selectedId.value, ws.selected.value?.fqdn], () => { source.value = ''; sourceName.value = ''; metadata.value = ''; asserted.value = false; notice.value = ''; void load() }, { immediate: true })
onBeforeUnmount(() => { generation++ })
</script>
<template>
  <main class="page-shell">
    <h1>Independent audit comparisons</h1>
    <p>Compare explicit observations with a saved SEOsmith run. Agreement is not ground truth, and proprietary scores are not comparable.</p>
    <p><NuxtLink to="/">Back to dashboard</NuxtLink></p>
    <p v-if="!ws.user.value">Sign in to access your websites.</p>
    <template v-else>
      <label>Website <select v-model="ws.selectedId.value"><option v-for="site in ws.sites.value" :key="site.id" :value="site.id">{{ site.fqdn }}</option></select></label>
      <p v-if="!ws.selected.value">Choose or add a website first.</p>
      <template v-else>
        <h2>Import controlled CSV</h2>
        <p>Use S15 controlled-csv-v1: <code>url,rule,state</code> with present, absent or unknown. Missing rows are unknown. Record tool version, configuration, scope, rendering, parser, thresholds, fetch outcomes and rule definitions below.</p>
        <label>UTF-8 CSV <input type="file" accept=".csv,text/csv" @change="fileChanged"></label>
        <label>Source and comparison limitations <textarea v-model="metadata" maxlength="10000" rows="4" /></label>
        <button :disabled="!source || busy" @click="save">Save import</button>
        <p v-if="notice" role="status">{{ notice }}</p><p v-if="error" role="alert">{{ error }}</p>
        <h2>Saved comparisons</h2><ul><li v-for="item in snapshots" :key="item.id"><button @click="openComparison(item)">{{ item.created_at }} · {{ item.semantics }}</button></li></ul><button v-if="snapshotCursor" @click="more('snapshots')">More comparisons</button>
        <h2>Saved evidence</h2>
        <p v-if="!imports.length">No independent imports found.</p>
        <ul><li v-for="item in imports" :key="item.id"><button @click="choose(item.id)">{{ item.metadata?.filename || 'CSV import' }} · {{ item.created_at }}</button> · SHA-256 {{ item.source_sha256 }}</li></ul><button v-if="importCursor" @click="more('imports')">More imports</button>
        <template v-if="selected">
          <p>Source: {{ selected.metadata?.provenance || 'Not provided' }}</p><button @click="download">Download original CSV</button>
          <label>SEOsmith run <select v-model="run" @change="chooseRun"><option value="">Choose a run</option><option v-if="run && !runs.some(item => item.delivery_id === run)" :value="run">Saved run {{ run }}</option><option v-for="item in runs" :key="item.delivery_id" :value="item.delivery_id">{{ item.scan_at }} · {{ item.summary?.outcome }}</option></select></label><button v-if="runCursor" @click="more('runs')">More SEOsmith runs</button>
          <label><input v-model="asserted" type="checkbox"> I verified this is the unmodified controlled SEOsmith 0.2.0 engine and 2026-11-01.1 ruleset. Version strings alone do not establish this.</label>
          <p>Only the two S15 metadata rules have a mapping. Other rules are unmapped; unavailable and partial evidence stays unknown. Differences may arise from scope, rendering, parsing, fetch results, thresholds or rule meaning.</p>
          <button v-if="report" :disabled="busy" @click="saveComparison">Save comparison</button>
          <table v-if="report"><thead><tr><th>URL</th><th>Rule</th><th>Independent</th><th>SEOsmith</th><th>Result</th></tr></thead><tbody><tr v-for="(row, index) in comparison" :key="index"><td>{{ row.url }}</td><td>{{ row.rule }}</td><td>{{ row.state }}</td><td>{{ row.seosmith }}</td><td>{{ row.category }}</td></tr></tbody></table>
        </template>
      </template>
    </template>
  </main>
</template>
