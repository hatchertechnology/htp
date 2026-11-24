import { describe, expect, it, vi } from 'vitest'
import { createIndependentAuditClient } from '../shared/utils/independent-audit-client'
const id = '00000000-0000-0000-0000-000000000001'
const base = 'https://api.example.test'
const cursor = { before: '2026-11-24T00:00:00Z', before_id: id }
const source = '\uFEFFurl,rule,state\r\n"é",rule,unknown\r\n'
const cases = [
  ['history', [id], 'independent-audits', 'GET', undefined, undefined, 'independent_audit_history', { p_website_id: id, p_id: null }],
  ['history', [id, null, cursor], 'independent-audits', 'GET', undefined, cursor, 'independent_audit_history', { p_website_id: id, p_id: null, p_before: cursor.before, p_before_id: id }],
  ['history', [id, id], `independent-audits/${id}`, 'GET', undefined, undefined, 'independent_audit_history', { p_website_id: id, p_id: id }],
  ['comparisons', [id, cursor], 'independent-comparisons', 'GET', undefined, cursor, 'independent_comparison_history', { p_website_id: id, p_before: cursor.before, p_before_id: id }],
  ['comparison', [id, id], `independent-comparisons/${id}`, 'GET', undefined, undefined, 'independent_comparison_detail', { p_website_id: id, p_comparison_id: id }],
  ['fingerprint', [id], 'independent-evidence/fingerprint', 'GET', undefined, undefined, 'independent_evidence_fingerprint', { p_website_id: id }],
  ['import', [id, source, { provenance: 'legacy' }], 'independent-audits', 'POST', { format: 'controlled-csv-v1', source, metadata: { provenance: 'legacy' } }, undefined, 'import_independent_audit', { p_website_id: id, p_format: 'controlled-csv-v1', p_source: source, p_metadata: { provenance: 'legacy' } }],
  ['save', [id, id, id, false], 'independent-comparisons', 'POST', { import_id: id, delivery_id: id, asserted: false }, undefined, 'save_independent_comparison', { p_website_id: id, p_import_id: id, p_delivery_id: id, p_asserted: false }],
  ['remove', [id, 'DELETE INDEPENDENT EVIDENCE', 'exact proof'], 'independent-evidence', 'DELETE', { confirmation: 'DELETE INDEPENDENT EVIDENCE', export_fingerprint: 'exact proof' }, undefined, 'delete_independent_audit_evidence', { p_website_id: id, p_confirmation: 'DELETE INDEPENDENT EVIDENCE', p_export_fingerprint: 'exact proof' }],
] as const
// Invoke the public typed methods from one shared contract table.
function invoke(client: ReturnType<typeof createIndependentAuditClient>, name: string, args: readonly unknown[]) {
  return (client as unknown as Record<string, (...args: any[]) => PromiseLike<unknown>>)[name]!(...args)
}
describe.each(cases)('%s %j', (name, args, path, method, body, query, rpc, rpcArgs) => {
  it('uses only the exact REST operation and retains response/null semantics', async () => {
    const request = vi.fn().mockResolvedValue(null), legacy = vi.fn()
    const client = createIndependentAuditClient({staticDashboard:true,apiBaseUrl:base,rolloutComparisons:true},request,legacy)
    expect(await invoke(client,name,args)).toEqual({data:null,error:null})
    expect(request).toHaveBeenCalledExactlyOnceWith(`${base}/websites/${id}/${path}`, { method, ...(body ? {body} : {}), ...(query ? {query} : {}), redirect:'error',retry:0 })
    expect(legacy).not.toHaveBeenCalled()
  })
  it('preserves exact legacy RPC calls, results and errors with static disabled', async () => {
    const result = {data: null, error: {message:'forbidden'}}, request = vi.fn(), legacy = vi.fn().mockResolvedValue(result)
    const client = createIndependentAuditClient({rolloutComparisons:true}, request, legacy)
    expect(await invoke(client,name,args)).toBe(result)
    expect(legacy).toHaveBeenCalledExactlyOnceWith(rpc,rpcArgs)
    expect(request).not.toHaveBeenCalled()
  })
  it('holds off by default and gives read-only precedence over writes', async () => {
    for (const flags of [{}, {rolloutComparisons:'true'}, {rolloutComparisonsReadOnly:'true'}, {rolloutComparisonsReadOnly:true}, {rolloutComparisons:true,rolloutComparisonsReadOnly:true}]) {
      const request = vi.fn().mockResolvedValue({}), legacy = vi.fn()
      const runtime = {staticDashboard:true,apiBaseUrl:base,...flags} as any
      const client = createIndependentAuditClient(runtime,request,legacy)
      if (method === 'GET' && runtime.rolloutComparisonsReadOnly === true) await invoke(client,name,args)
      else { await expect(invoke(client,name,args)).rejects.toMatchObject({statusCode:503}); expect(request).not.toHaveBeenCalled() }
      expect(legacy).not.toHaveBeenCalled()
    }
  })
})
it('rejects path injection and invalid origins without fetching', async () => {
  const request=vi.fn(), legacy=vi.fn()
  const client=createIndependentAuditClient({staticDashboard:true,apiBaseUrl:base,rolloutComparisons:true},request,legacy)
  for (const bad of [id+'\n',id+'/other','../'+id,'not-an-id', id+'?rpc=x']) {
    await expect(client.history(bad)).rejects.toThrow('ID')
    await expect(client.comparison(id,bad)).rejects.toThrow('ID')
  }
  const invalid=createIndependentAuditClient({staticDashboard:true,apiBaseUrl:'https://api.example.test/path',rolloutComparisons:true},request,legacy)
  await expect(invalid.fingerprint(id)).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
})
it('uses existing SEOsmith read transport and propagates failures without retry/fallback', async () => {
  const failure={statusCode:403},request=vi.fn().mockRejectedValue(failure),legacy=vi.fn()
  const client=createIndependentAuditClient({staticDashboard:true,apiBaseUrl:base,rolloutComparisons:true},request,legacy)
  expect(client.auditPath(id)).toBe(`${base}/websites/${id}/seo/audits`)
  expect(client.auditPath(id,id)).toBe(`${base}/websites/${id}/seo/audits/${id}`)
  await expect(client.fingerprint(id)).rejects.toBe(failure)
  expect(request).toHaveBeenCalledTimes(1); expect(legacy).not.toHaveBeenCalled()
  expect(createIndependentAuditClient({},request,legacy).auditPath(id)).toBe(`/api/websites/${id}/seo/audits`)
})
