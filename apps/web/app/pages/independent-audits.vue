<script setup lang="ts">
import { compareIndependent, parseControlledCsv, CURRENT_SEMANTICS } from '#shared/utils/independent-audit'
useHead({ title: 'Hatch · Independent audit comparisons' })
const config = useRuntimeConfig().public
const readOnly = config.rolloutComparisonsReadOnly === true
const canWrite = config.rolloutComparisons === true && !readOnly
const comparisonEnabled = canWrite || readOnly
const ws = useWorkspace(), supabase = useNuxtApp().$supabase
const snapshots = ref<any[]>([]), imports = ref<any[]>([]), selected = ref<any>(null), runs = ref<any[]>([]), run = ref(''), report = ref<any>(null)
const importCursor = ref<any>(null), snapshotCursor = ref<any>(null), runCursor = ref<any>(null)
const semantics = ref(CURRENT_SEMANTICS), deleteConfirmation = ref(''), exportFingerprint = ref('')
const source = ref(''), sourceName = ref(''), metadata = ref(''), asserted = ref(false), busy = ref(false), error = ref(''), notice = ref('')
let generation = 0, selectionGeneration = 0
const comparison = computed(() => {
  if (!selected.value || !report.value) return []
  if (semantics.value !== CURRENT_SEMANTICS) return []
  return compareIndependent(parseControlledCsv(selected.value.source_text), report.value, asserted.value, semantics.value)
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
  if (!comparisonEnabled || !site || !ws.user.value) return
  try {
    const [history, audits, comparisons] = await Promise.all([
      supabase.rpc('independent_audit_history', { p_website_id: site, p_id: null }),
      canWrite ? ws.request<any>(`/api/websites/${site}/seo/audits`) : Promise.resolve({ items: [], next_cursor: null }),
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
  selected.value = null; run.value = ''; report.value = null; asserted.value = false; semantics.value = CURRENT_SEMANTICS
  try {
    const result = await supabase.rpc('independent_audit_history', { p_website_id: site, p_id: id })
    if (result.error) throw result.error
    if (gen === generation && selection === selectionGeneration) selected.value = result.data
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
}
async function chooseRun() {
  const gen = generation, site = ws.selectedId.value, id = run.value; report.value = null; asserted.value = false; semantics.value = CURRENT_SEMANTICS
  if (!id) return
  try {
    const detail = await ws.request<any>(`/api/websites/${site}/seo/audits/${id}`)
    if (gen === generation && id === run.value) report.value = detail.report
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
}
async function saveComparison() {
  if (!canWrite || !selected.value || !run.value || !report.value || busy.value) return
  const gen = generation; busy.value = true
  try {
    const result = await supabase.rpc('save_independent_comparison', { p_website_id: ws.selectedId.value, p_import_id: selected.value.id, p_delivery_id: run.value, p_asserted: asserted.value })
    if (result.error) throw result.error
    if (gen === generation) { snapshots.value = [result.data, ...snapshots.value]; notice.value = 'Comparison saved.' }
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
  finally { busy.value = false }
}
async function openComparison(item: any) {
  const gen = generation, selection = ++selectionGeneration, site = ws.selectedId.value
  selected.value = null; report.value = null; asserted.value = false; error.value = ''
  try {
    const result = await supabase.rpc('independent_comparison_detail', { p_website_id: site, p_comparison_id: item.id })
    if (result.error) throw result.error
    if (gen !== generation || selection !== selectionGeneration) return
    if (!result.data) throw new Error('Saved comparison is unavailable.')
    const detail = result.data
    selected.value = detail.source; run.value = detail.comparison.delivery_id
    semantics.value = detail.comparison.semantics; report.value = detail.seosmith.report
    asserted.value = detail.comparison.unmodified_v1_asserted
  } catch (cause) { if (gen === generation && selection === selectionGeneration) error.value = failureMessage(cause) }
}
async function exportEvidence() {
  if (busy.value) return
  const site = ws.selectedId.value, gen = generation; busy.value = true; error.value = ''
  try {
    const first = await supabase.rpc('independent_evidence_fingerprint', { p_website_id: site })
    if (first.error) throw first.error
    const sources: any[] = [], comparisons: any[] = []
    for (const kind of ['sources', 'comparisons']) {
      let cursor: any = null
      do {
        const fn = kind === 'sources' ? 'independent_audit_history' : 'independent_comparison_history'
        const page = await supabase.rpc(fn, { p_website_id: site, ...(kind === 'sources' ? { p_id: null } : {}), ...(cursor ? { p_before: cursor.before, p_before_id: cursor.before_id } : {}) })
        if (page.error) throw page.error
        for (const item of page.data.items) {
          const detail = await supabase.rpc(kind === 'sources' ? 'independent_audit_history' : 'independent_comparison_detail', kind === 'sources' ? { p_website_id: site, p_id: item.id } : { p_website_id: site, p_comparison_id: item.id })
          if (detail.error || !detail.data) throw detail.error || new Error('Evidence changed during export; try again.')
          ;(kind === 'sources' ? sources : comparisons).push(detail.data)
        }
        cursor = page.data.next_cursor
      } while (cursor)
    }
    const last = await supabase.rpc('independent_evidence_fingerprint', { p_website_id: site })
    if (last.error) throw last.error
    if (first.data !== last.data) throw new Error('Evidence changed during export; try again.')
    if (gen !== generation) return
    const blob = new Blob([JSON.stringify({ version: 1, website_id: site, sources, comparisons }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `independent-evidence-${site}.json`; link.click(); URL.revokeObjectURL(url)
    exportFingerprint.value = last.data
    notice.value = 'Evidence export prepared. Verify your download before deleting anything.'
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
  finally { busy.value = false }
}
async function deleteEvidence() {
  if (!canWrite || busy.value || !exportFingerprint.value || deleteConfirmation.value !== 'DELETE INDEPENDENT EVIDENCE') return
  if (!window.confirm('Permanently delete all independent imports and saved comparisons for this website, including prior hostnames? Export and verify them first. SEOsmith reports remain.')) return
  const gen = generation, site = ws.selectedId.value; busy.value = true; error.value = ''
  try {
    const result = await supabase.rpc('delete_independent_audit_evidence', { p_website_id: site, p_confirmation: deleteConfirmation.value, p_export_fingerprint: exportFingerprint.value })
    if (result.error) throw result.error
    if (gen !== generation) return
    deleteConfirmation.value = ''; exportFingerprint.value = ''; await load(); notice.value = `Deleted ${result.data.imports_deleted} imports and ${result.data.comparisons_deleted} comparisons.`
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
  finally { busy.value = false }
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
  if (!canWrite || !ws.selectedId.value || !source.value || busy.value) return
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
watch(() => [ws.user.value?.id, ws.selectedId.value, ws.selected.value?.fqdn], () => { source.value = ''; sourceName.value = ''; metadata.value = ''; asserted.value = false; semantics.value = CURRENT_SEMANTICS; deleteConfirmation.value = ''; exportFingerprint.value = ''; notice.value = ''; void load() }, { immediate: true })
onBeforeUnmount(() => { generation++ })
</script>
<template>
  <main class="page-shell">
    <h1>Independent audit comparisons</h1>
    <p>Compare explicit observations with a saved SEOsmith run. Agreement is not ground truth, and proprietary scores are not comparable.</p>
    <p><NuxtLink to="/">Back to dashboard</NuxtLink></p>
    <p v-if="!comparisonEnabled" role="status">Independent audit comparisons are not available yet.</p>
    <p v-else-if="!ws.user.value">Sign in to access your websites.</p>
    <template v-else>
      <label>Website <select v-model="ws.selectedId.value"><option v-for="site in ws.sites.value" :key="site.id" :value="site.id">{{ site.fqdn }}</option></select></label>
      <p v-if="!ws.selected.value">Choose or add a website first.</p>
      <template v-else>
        <p v-if="readOnly" role="status">Read-only: showing saved independent evidence and comparisons.</p>
        <template v-if="canWrite">
        <h2>Import controlled CSV</h2>
        <p>Use S15 controlled-csv-v1: <code>url,rule,state</code> with present, absent or unknown. Missing rows are unknown. Record tool version, configuration, scope, rendering, parser, thresholds, fetch outcomes and rule definitions below.</p>
        <label>UTF-8 CSV <input type="file" accept=".csv,text/csv" @change="fileChanged"></label>
        <label>Source and comparison limitations <textarea v-model="metadata" maxlength="10000" rows="4" /></label>
        <button :disabled="!source || busy" @click="save">Save import</button>
        <p v-if="notice" role="status">{{ notice }}</p><p v-if="error" role="alert">{{ error }}</p>
        <h2>Evidence export and removal</h2>
        <p>Export includes imports, saved comparisons and their pinned SEOsmith reports, including prior hostnames. Export and verify the file before removing evidence. Removal is permanent and may be needed before deleting this website or account.</p>
        <button :disabled="busy" @click="exportEvidence">Export all independent evidence</button>
        <label>Type DELETE INDEPENDENT EVIDENCE to enable removal <input v-model="deleteConfirmation" autocomplete="off"></label>
        <button :disabled="busy || !exportFingerprint || deleteConfirmation !== 'DELETE INDEPENDENT EVIDENCE'" @click="deleteEvidence">Delete independent evidence</button>
        </template>
        <p v-if="readOnly && error" role="alert">{{ error }}</p>
        <h2>Saved comparisons</h2><ul><li v-for="item in snapshots" :key="item.id"><button @click="openComparison(item)">{{ item.created_at }} · {{ item.fqdn }} · {{ item.semantics }}</button></li></ul><button v-if="snapshotCursor" @click="more('snapshots')">More comparisons</button>
        <h2>Saved evidence</h2>
        <p v-if="!imports.length">No independent imports found.</p>
        <ul><li v-for="item in imports" :key="item.id"><button @click="choose(item.id)">{{ item.metadata?.filename || 'CSV import' }} · {{ item.fqdn }} · {{ item.created_at }}</button> · SHA-256 {{ item.source_sha256 }}</li></ul><button v-if="importCursor" @click="more('imports')">More imports</button>
        <template v-if="selected">
          <p>Source: {{ selected.metadata?.provenance || 'Not provided' }}</p><button @click="download">Download original CSV</button>
          <template v-if="canWrite"><label>SEOsmith run <select v-model="run" @change="chooseRun"><option value="">Choose a run</option><option v-if="run && !runs.some(item => item.delivery_id === run)" :value="run">Saved run {{ run }}</option><option v-for="item in runs" :key="item.delivery_id" :value="item.delivery_id">{{ item.scan_at }} · {{ item.summary?.outcome }}</option></select></label><button v-if="runCursor" @click="more('runs')">More SEOsmith runs</button>
          <label><input v-model="asserted" type="checkbox"> I verified this is the unmodified controlled SEOsmith 0.2.0 engine and 2026-11-01.1 ruleset. Version strings alone do not establish this.</label></template>
          <p v-else-if="report">Saved assertion: {{ asserted ? 'verified by the original author' : 'not asserted' }}.</p>
          <p>Only the two S15 metadata rules have a mapping. Other rules are unmapped; unavailable and partial evidence stays unknown. Differences may arise from scope, rendering, parsing, fetch results, thresholds or rule meaning.</p>
          <p v-if="report && semantics !== CURRENT_SEMANTICS" role="alert">This comparison uses unsupported semantics {{ semantics }}. Its original CSV can still be downloaded.</p>
          <button v-if="canWrite && report && semantics === CURRENT_SEMANTICS" :disabled="busy" @click="saveComparison">Save comparison</button>
          <table v-if="report && semantics === CURRENT_SEMANTICS"><thead><tr><th>URL</th><th>Rule</th><th>Independent</th><th>SEOsmith</th><th>Result</th></tr></thead><tbody><tr v-for="(row, index) in comparison" :key="index"><td>{{ row.url }}</td><td>{{ row.rule }}</td><td>{{ row.state }}</td><td>{{ row.seosmith }}</td><td>{{ row.category }}</td></tr></tbody></table>
        </template>
      </template>
    </template>
  </main>
</template>
