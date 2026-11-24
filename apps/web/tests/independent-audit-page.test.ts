// Exercise the actual page controller without a browser or a database. Every
// transport result and download is synthetic; imports/removals never leave mocks.
import { readFileSync } from 'node:fs'
import { transpile } from 'typescript'
import { computed, reactive, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { createIndependentAuditClient } from '../shared/utils/independent-audit-client'
import * as rules from '../shared/utils/independent-audit'
const site = '00000000-0000-0000-0000-000000000001', id = '00000000-0000-0000-0000-000000000002'
const script = readFileSync(new URL('../app/pages/independent-audits.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1]!.split('</script>')[0]!.replace(/^import .*$/gm, '')
const js = transpile(`${script}\nreturn { load, choose, openComparison, exportEvidence, deleteEvidence, save, saveComparison, deleteConfirmation, exportFingerprint, error, selected, report, run, asserted, semantics, source, snapshots, imports, notice };`, {target:99})
function setup(flags: Record<string, unknown> = {rolloutComparisons:true}, changed = false) {
  let fingerprint = 0
  const calls: Array<{path:string;options:any}> = [], downloads: Blob[] = [], watchers: Array<() => void> = []
  const raw = {id, fqdn:'old.example', source_text:'url,rule,state\r\nhttps://old.example/,missing_title,unknown\r\n', metadata:{provenance:'legacy note'}}
  const detail = {comparison:{id,delivery_id:id,semantics:'future',unmodified_v1_asserted:false},source:raw,seosmith:{report:{pages:[]},report_json:'original bytes',fqdn:'old.example',sha256:'hash'}}
  const request = vi.fn(async (path:string, options:any={}) => {
    calls.push({path,options})
    if (path.endsWith('/fingerprint')) return changed && fingerprint++ > 0 ? 'changed' : 'proof'
    if (path.endsWith(`/independent-audits/${id}`)) return raw
    if (path.endsWith(`/independent-comparisons/${id}`)) return detail
    if (options.method === 'DELETE') return {imports_deleted:2,comparisons_deleted:1}
    if (path.endsWith('/independent-audits')) return {items:[{id}],next_cursor:options.query ? null : {before:'date',before_id:id}}
    if (path.endsWith('/independent-comparisons')) return {items:[{id}],next_cursor:null}
    if (path.endsWith('/seo/audits')) return {items:[],next_cursor:null}
    throw new Error(`Unexpected synthetic path ${path}`)
  })
  const legacy=vi.fn(() => {throw new Error('Static UI reached Supabase RPC')})
  const ws={selectedId:ref(site),selected:ref({fqdn:'new.example'}),user:ref({id:'owner'}),request}
  const confirm=vi.fn(() => false), click=vi.fn()
  vi.stubGlobal('window',{confirm})
  vi.stubGlobal('document',{createElement:() => ({click})})
  vi.spyOn(URL,'createObjectURL').mockImplementation(blob => {downloads.push(blob as Blob); return 'blob:synthetic'})
  vi.spyOn(URL,'revokeObjectURL').mockImplementation(() => {})
  const deps = {ref,reactive,computed,watch:(_source:unknown,fn:() => void) => watchers.push(fn),onBeforeUnmount:vi.fn(),useHead:vi.fn(),useRuntimeConfig:() => ({public:{staticDashboard:true,apiBaseUrl:'https://api.example.test',...flags}}),useWorkspace:() => ws,useNuxtApp:() => ({$supabase:{rpc:legacy}}),createIndependentAuditClient,...rules,failureMessage:(e:any) => e.message}
  const page=new Function(...Object.keys(deps),js)(...Object.values(deps))
  return {page,request,legacy,calls,downloads,confirm,click,watchers,ws,raw,detail}
}
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals()})
it('exports every page, pinned raw evidence and original report before granting exact removal proof', async () => {
  const t=setup()
  await t.page.exportEvidence()
  expect(t.downloads).toHaveLength(1)
  const evidence=JSON.parse(await t.downloads[0]!.text())
  expect(evidence.sources).toEqual([t.raw,t.raw])
  expect(evidence.comparisons).toEqual([t.detail])
  expect(t.calls.filter(c => c.path.endsWith('/fingerprint'))).toHaveLength(2)
  expect(t.page.exportFingerprint.value).toBe('proof')
  await t.page.deleteEvidence() // phrase absent
  expect(t.confirm).not.toHaveBeenCalled()
  t.page.deleteConfirmation.value='DELETE INDEPENDENT EVIDENCE'
  await t.page.deleteEvidence() // confirmation declined
  expect(t.calls.some(c => c.options.method === 'DELETE')).toBe(false)
  t.confirm.mockReturnValue(true)
  await t.page.deleteEvidence()
  expect(t.calls.find(c => c.options.method === 'DELETE')?.options.body).toEqual({confirmation:'DELETE INDEPENDENT EVIDENCE',export_fingerprint:'proof'})
  expect(t.page.exportFingerprint.value).toBe('')
  expect(t.page.deleteConfirmation.value).toBe('')
  expect(t.page.notice.value).toContain('Deleted 2 imports and 1 comparisons')
  expect(t.legacy).not.toHaveBeenCalled()
})
it('refuses export proof and download if evidence changes between fingerprints', async () => {
  const t=setup(undefined,true)
  await t.page.exportEvidence()
  expect(t.page.error.value).toContain('Evidence changed')
  expect(t.page.exportFingerprint.value).toBe('')
  expect(t.downloads).toHaveLength(0)
})
it.each([{}, {rolloutComparisonsReadOnly:true}, {rolloutComparisons:true,rolloutComparisonsReadOnly:true}])('holds writes with mode %j and preserves read-only replay', async flags => {
  const t=setup(flags)
  t.page.source.value=t.raw.source_text
  t.page.deleteConfirmation.value='DELETE INDEPENDENT EVIDENCE';t.page.exportFingerprint.value='proof'
  await t.page.save();await t.page.saveComparison();await t.page.deleteEvidence()
  expect(t.request).not.toHaveBeenCalled();expect(t.confirm).not.toHaveBeenCalled()
  await t.page.load()
  expect(t.calls.some(c => c.path.endsWith('/seo/audits'))).toBe(false)
  if ('rolloutComparisonsReadOnly' in flags) {
    await t.page.openComparison({id})
    expect(t.page.semantics.value).toBe('future')
    expect(t.page.selected.value.metadata.provenance).toBe('legacy note')
    await t.page.choose(id)
    expect(t.page.run.value).toBe('');expect(t.page.report.value).toBe(null)
  } else expect(t.request).not.toHaveBeenCalled()
})
it('clears export proof on workspace changes before loading another website', async () => {
  const t=setup()
  await t.page.exportEvidence()
  t.ws.selectedId.value=id
  t.watchers[0]!()
  expect(t.page.exportFingerprint.value).toBe('')
  expect(t.page.deleteConfirmation.value).toBe('')
})
