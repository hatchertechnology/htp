<script setup lang="ts">
import { createIndependentAuditClient } from '#shared/utils/independent-audit-client'
import { compareIndependent, parseControlledCsv, CURRENT_SEMANTICS, isSupportedSemantics, PROVENANCE_FIELDS, normalizeProvenance, provenanceEntries, summarizeComparison, sourceByteLength } from '#shared/utils/independent-audit'
import { formatInstant } from '#shared/utils/local-time'
useHead({ title: 'Hatch · Independent audit comparisons' })
const config = useRuntimeConfig().public
const readOnly = config.rolloutComparisonsReadOnly === true
const canWrite = config.rolloutComparisons === true && !readOnly
const comparisonEnabled = canWrite || readOnly
const ws = useWorkspace(), supabase = useNuxtApp().$supabase
const independent = createIndependentAuditClient(config, ws.request, (name, args) => supabase.rpc(name, args))
const snapshots = ref<any[]>([]), imports = ref<any[]>([]), selected = ref<any>(null), runs = ref<any[]>([]), run = ref(''), report = ref<any>(null)
const importCursor = ref<any>(null), snapshotCursor = ref<any>(null), runCursor = ref<any>(null)
const semantics = ref(CURRENT_SEMANTICS), deleteConfirmation = ref(''), exportFingerprint = ref('')
const source = ref(''), sourceName = ref(''), asserted = ref(false), busy = ref(false), error = ref(''), notice = ref('')
const provenance = reactive<Record<string, string>>(Object.fromEntries(PROVENANCE_FIELDS.map(field => [field.key, ''])))
const reportMeta = ref<{ fqdn?: string; sha256?: string } | null>(null)
let generation = 0, selectionGeneration = 0
const comparison = computed(() => {
  if (!selected.value || !report.value) return []
  if (!isSupportedSemantics(semantics.value)) return []
  return compareIndependent(parseControlledCsv(selected.value.source_text), report.value, asserted.value, semantics.value)
})
/** A fresh schema-1 report still replays under its own semantics; new saves stay on the current one. */
function freshSemantics(value: any): string { return value?.schema_version === 1 ? 's15-metadata-1' : CURRENT_SEMANTICS }
const summary = computed(() => summarizeComparison(comparison.value))
const sourceProvenance = computed(() => provenanceEntries(selected.value?.metadata?.provenance))
function download() {
  if (!selected.value) return
  const url = URL.createObjectURL(new Blob([selected.value.source_text], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = 'independent-audit.csv'; link.click(); URL.revokeObjectURL(url)
}
async function load() {
  const gen = ++generation, site = ws.selectedId.value
  selectionGeneration++
  importCursor.value = null; snapshotCursor.value = null; runCursor.value = null
  snapshots.value = []; imports.value = []; selected.value = null; runs.value = []; report.value = null; reportMeta.value = null; run.value = ''; error.value = ''
  if (!comparisonEnabled || !site || !ws.user.value) return
  try {
    const [history, audits, comparisons] = await Promise.all([
      independent.history(site),
      canWrite ? ws.request<any>(independent.auditPath(site)) : Promise.resolve({ items: [], next_cursor: null }),
      independent.comparisons(site),
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
      const result = await ws.request<any>(independent.auditPath(site), { query: cursor })
      if (gen === generation) { runs.value.push(...result.items); runCursor.value = result.next_cursor }
    } else {
      const result = await (kind === 'imports' ? independent.history(site, null, cursor) : independent.comparisons(site, cursor))
      if (result.error) throw result.error
      if (gen !== generation) return
      if (kind === 'imports') { imports.value.push(...result.data.items); importCursor.value = result.data.next_cursor }
      else { snapshots.value.push(...result.data.items); snapshotCursor.value = result.data.next_cursor }
    }
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
}
async function choose(id: string) {
  const gen = generation, selection = ++selectionGeneration, site = ws.selectedId.value
  selected.value = null; run.value = ''; report.value = null; reportMeta.value = null; asserted.value = false; semantics.value = CURRENT_SEMANTICS
  try {
    const result = await independent.history(site, id)
    if (result.error) throw result.error
    if (gen === generation && selection === selectionGeneration) selected.value = result.data
  } catch (cause) { if (gen === generation && selection === selectionGeneration) { reportMeta.value = null; error.value = failureMessage(cause) } }
}
async function chooseRun() {
  const gen = generation, site = ws.selectedId.value, id = run.value; report.value = null; reportMeta.value = null; asserted.value = false; semantics.value = CURRENT_SEMANTICS
  if (!id) return
  try {
    const detail = await ws.request<any>(independent.auditPath(site, id))
    if (gen === generation && id === run.value) { report.value = detail.report; semantics.value = freshSemantics(detail.report); reportMeta.value = { fqdn: detail.fqdn ?? ws.selected.value?.fqdn, sha256: detail.sha256 } }
  } catch (cause) { if (gen === generation && id === run.value) error.value = failureMessage(cause) }
}
async function saveComparison() {
  if (!canWrite || !selected.value || !run.value || !report.value || busy.value) return
  const gen = generation; busy.value = true
  try {
    const result = await independent.save(ws.selectedId.value, selected.value.id, run.value, asserted.value)
    if (result.error) throw result.error
    if (gen === generation) { snapshots.value = [result.data, ...snapshots.value]; notice.value = 'Comparison saved.' }
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
  finally { busy.value = false }
}
async function openComparison(item: any) {
  const gen = generation, selection = ++selectionGeneration, site = ws.selectedId.value
  selected.value = null; report.value = null; reportMeta.value = null; asserted.value = false; error.value = ''
  try {
    const result = await independent.comparison(site, item.id)
    if (result.error) throw result.error
    if (gen !== generation || selection !== selectionGeneration) return
    if (!result.data) throw new Error('Saved comparison is unavailable.')
    const detail = result.data
    selected.value = detail.source; run.value = detail.comparison.delivery_id
    reportMeta.value = { fqdn: detail.seosmith.fqdn, sha256: detail.seosmith.sha256 }
    semantics.value = detail.comparison.semantics; report.value = detail.seosmith.report
    asserted.value = detail.comparison.unmodified_v1_asserted
  } catch (cause) { if (gen === generation && selection === selectionGeneration) error.value = failureMessage(cause) }
}
async function exportEvidence() {
  if (busy.value) return
  const site = ws.selectedId.value, gen = generation; busy.value = true; error.value = ''
  try {
    const first = await independent.fingerprint(site)
    if (first.error) throw first.error
    const sources: any[] = [], comparisons: any[] = []
    for (const kind of ['sources', 'comparisons']) {
      let cursor: any = null
      do {
        const page = await (kind === 'sources' ? independent.history(site, null, cursor) : independent.comparisons(site, cursor))
        if (page.error) throw page.error
        for (const item of page.data.items) {
          const detail = await (kind === 'sources' ? independent.history(site, item.id) : independent.comparison(site, item.id))
          if (detail.error || !detail.data) throw detail.error || new Error('Evidence changed during export; try again.')
          ;(kind === 'sources' ? sources : comparisons).push(detail.data)
        }
        cursor = page.data.next_cursor
      } while (cursor)
    }
    const last = await independent.fingerprint(site)
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
    const result = await independent.remove(site, deleteConfirmation.value, exportFingerprint.value)
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
    const result = await independent.import(site, source.value, { filename: sourceName.value, provenance: normalizeProvenance(provenance) })
    if (result.error) throw result.error
    if (gen !== generation) return
    source.value = ''; sourceName.value = ''; for (const field of PROVENANCE_FIELDS) provenance[field.key] = ''; await load(); notice.value = 'Source saved.'
  } catch (cause) { if (gen === generation) error.value = failureMessage(cause) }
  finally { busy.value = false }
}
watch(() => [ws.user.value?.id, ws.selectedId.value, ws.selected.value?.fqdn], () => { source.value = ''; sourceName.value = ''; for (const field of PROVENANCE_FIELDS) provenance[field.key] = ''; reportMeta.value = null; asserted.value = false; semantics.value = CURRENT_SEMANTICS; deleteConfirmation.value = ''; exportFingerprint.value = ''; notice.value = ''; void load() }, { immediate: true })
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
      <p v-if="!ws.selected.value">Choose a website in the header, or add one on <NuxtLink to="/websites">Websites</NuxtLink>.</p>
      <template v-else>
        <p v-if="readOnly" role="status">Read-only: showing saved independent evidence and comparisons.</p>
        <template v-if="canWrite">
        <h2>Import controlled CSV</h2>
        <p>Use S15 controlled-csv-v1: <code>url,rule,state</code> with present, absent or unknown. Missing rows are unknown. Record tool version, configuration, scope, rendering, parser, thresholds, fetch outcomes and rule definitions below.</p>
        <label>UTF-8 CSV <input type="file" accept=".csv,text/csv" @change="fileChanged"></label>
        <fieldset>
          <legend>Source metadata</legend>
          <p>Record what produced this export. Empty fields stay unknown; the tool's claims are not authenticated.</p>
          <label v-for="field in PROVENANCE_FIELDS" :key="field.key">{{ field.label }} <input v-model="provenance[field.key]" :placeholder="field.placeholder" autocomplete="off"></label>
        </fieldset>
        <button :disabled="!source || busy" @click="save">Save import</button>
        <p v-if="notice" role="status">{{ notice }}</p><p v-if="error" role="alert">{{ error }}</p>
        <h2>Evidence export and removal</h2>
        <p>Export includes imports, saved comparisons and their pinned SEOsmith reports, including prior hostnames. Export and verify the file before removing evidence. Removal is permanent and may be needed before deleting this website or account.</p>
        <button :disabled="busy" @click="exportEvidence">Export all independent evidence</button>
        <label>Type DELETE INDEPENDENT EVIDENCE to enable removal <input v-model="deleteConfirmation" autocomplete="off"></label>
        <button :disabled="busy || !exportFingerprint || deleteConfirmation !== 'DELETE INDEPENDENT EVIDENCE'" @click="deleteEvidence">Delete independent evidence</button>
        </template>
        <p v-if="readOnly && error" role="alert">{{ error }}</p>
        <h2>Saved comparisons</h2><p v-if="!snapshots.length">No saved comparisons yet. Open a saved evidence import and compare it with an SEOsmith run.</p><ul><li v-for="item in snapshots" :key="item.id"><button @click="openComparison(item)"><time :datetime="item.created_at" :title="item.created_at">{{ formatInstant(item.created_at) }}</time> · {{ item.fqdn }} · {{ item.semantics }}</button></li></ul><button v-if="snapshotCursor" @click="more('snapshots')">More comparisons</button>
        <h2>Saved evidence</h2>
        <p v-if="!imports.length">No independent imports found.</p>
        <ul><li v-for="item in imports" :key="item.id"><button @click="choose(item.id)">{{ item.metadata?.filename || 'CSV import' }} · {{ item.fqdn }} · <time :datetime="item.created_at" :title="item.created_at">{{ formatInstant(item.created_at) }}</time></button> · SHA-256 {{ item.source_sha256 }}</li></ul><button v-if="importCursor" @click="more('imports')">More imports</button>
        <template v-if="selected">
          <h3>Source metadata</h3>
          <dl><template v-for="field in sourceProvenance" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ field.value ?? 'Unknown / not provided' }}</dd></template></dl>
          <p>Original file: {{ selected.metadata?.filename || 'unnamed' }} · {{ sourceByteLength(selected.source_text) }} bytes · SHA-256 {{ selected.source_sha256 }}</p>
          <button @click="download">Download original CSV</button>
          <template v-if="canWrite"><label>SEOsmith run <select v-model="run" @change="chooseRun"><option value="">Choose a run</option><option v-if="run && !runs.some(item => item.delivery_id === run)" :value="run">Saved run {{ run }}</option><option v-for="item in runs" :key="item.delivery_id" :value="item.delivery_id">{{ formatInstant(item.scan_at) }} · {{ item.summary?.outcome }}</option></select></label><button v-if="runCursor" @click="more('runs')">More SEOsmith runs</button>
          <label><input v-model="asserted" type="checkbox"> I verified this is the unmodified controlled SEOsmith 0.2.0 engine and 2026-11-01.1 ruleset. Version strings alone do not establish this.</label></template>
          <p v-else-if="report">Saved assertion: {{ asserted ? 'verified by the original author' : 'not asserted' }}.</p>
          <p>Only the two S15 metadata rules have a mapping. Other rules are unmapped; unavailable and partial evidence stays unknown. Differences may arise from scope, rendering, parsing, fetch results, thresholds or rule meaning.</p>
          <p v-if="reportMeta && report">Compared SEOsmith report: {{ reportMeta.fqdn || 'unknown host' }} · {{ reportMeta.sha256 ? 'SHA-256 ' + reportMeta.sha256 : 'SHA-256 not provided' }}</p>
          <p v-if="report && !isSupportedSemantics(semantics)" role="alert">This comparison uses unsupported semantics {{ semantics }}. {{ readOnly ? 'Its original CSV can still be downloaded.' : 'Its original evidence can still be exported.' }}</p>
          <p v-else-if="report && semantics !== CURRENT_SEMANTICS" role="status">This SEOsmith report has schema version {{ report.schema_version }}. It replays under {{ semantics }} and is not comparable under {{ CURRENT_SEMANTICS }}; saving a comparison requires a schema 4 report.</p>
          <button v-if="canWrite && report && semantics === CURRENT_SEMANTICS" :disabled="busy" @click="saveComparison">Save comparison</button>
          <template v-if="report && isSupportedSemantics(semantics)">
            <p role="status">Discrepancies: {{ summary.agreement }} agreement · {{ summary.independent_only }} independent-only · {{ summary.seosmith_only }} SEOsmith-only · {{ summary.unknown }} unknown · {{ summary.unmapped }} unmapped · {{ summary.total }} total.</p>
            <table><thead><tr><th>URL</th><th>Rule</th><th>Independent</th><th>SEOsmith</th><th>Result</th></tr></thead><tbody><tr v-for="(row, index) in comparison" :key="index"><td>{{ row.url }}</td><td>{{ row.rule }}</td><td>{{ row.state }}</td><td>{{ row.seosmith }}<template v-if="row.reason"> ({{ row.reason }}<template v-if="row.reason_count"> × {{ row.reason_count }}</template>)</template></td><td>{{ row.category }}</td></tr></tbody></table>
          </template>
        </template>
      </template>
    </template>
  </main>
</template>

<style scoped>
/* The workspace pages share the Operations Desk rhythm; this plain shell
   needs the same breathing room between its paragraphs and sections. */
.page-shell > p { margin-block: 8px; }
.page-shell h2 { margin: 26px 0 10px; }
.page-shell h3 { margin: 22px 0 8px; }
.page-shell ul { margin-block: 8px; }
</style>
