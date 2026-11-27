import { websiteApiOrigin } from './websites-client'
import { resolveSeosmithReadPath } from './seosmith-client'

type Runtime = { staticDashboard?: boolean; apiBaseUrl?: unknown; rolloutComparisons?: boolean; rolloutComparisonsReadOnly?: boolean }
type Cursor = { before: string; before_id: string } | null
// RPC is a legacy-only dependency. No RPC name or SQL arguments travel to REST.
type Legacy = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>
type Request = (path: string, options?: Record<string, unknown>) => Promise<any>
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export function createIndependentAuditClient(runtime: Runtime, request: Request, legacy: Legacy) {
  const staticMode = runtime.staticDashboard === true
  function path(site: string, resource: string, item?: string) {
    if (site.length !== 36 || !UUID.test(site) || (item !== undefined && (item.length !== 36 || !UUID.test(item)))) throw new Error('Invalid independent evidence ID.')
    return `${websiteApiOrigin(runtime.apiBaseUrl)}/websites/${site}/${resource}${item === undefined ? '' : `/${item}`}`
  }
  async function rest(site: string, resource: string, method = 'GET', body?: unknown, query?: Cursor, item?: string) {
    const readOnly = runtime.rolloutComparisonsReadOnly === true
    if (method === 'GET' ? !(runtime.rolloutComparisons === true || readOnly) : runtime.rolloutComparisons !== true || readOnly) {
      throw Object.assign(new Error('Independent audit comparisons are not available yet.'), { statusCode: 503 })
    }
    const data = await request(path(site, resource, item), { method, ...(body === undefined ? {} : { body }), ...(query ? { query: { before: query.before, before_id: query.before_id } } : {}), redirect: 'error', retry: 0 })
    return { data, error: null }
  }
  return {
    history: (site: string, id: string | null = null, cursor: Cursor = null) => staticMode
      ? rest(site, 'independent-audits', 'GET', undefined, cursor, id ?? undefined)
      : legacy('independent_audit_history', { p_website_id: site, p_id: id, ...(cursor ? { p_before: cursor.before, p_before_id: cursor.before_id } : {}) }),
    comparisons: (site: string, cursor: Cursor = null) => staticMode
      ? rest(site, 'independent-comparisons', 'GET', undefined, cursor)
      : legacy('independent_comparison_history', { p_website_id: site, ...(cursor ? { p_before: cursor.before, p_before_id: cursor.before_id } : {}) }),
    comparison: (site: string, id: string) => staticMode
      ? rest(site, 'independent-comparisons', 'GET', undefined, undefined, id)
      : legacy('independent_comparison_detail', { p_website_id: site, p_comparison_id: id }),
    fingerprint: (site: string) => staticMode
      ? rest(site, 'independent-evidence/fingerprint')
      : legacy('independent_evidence_fingerprint', { p_website_id: site }),
    import: (site: string, source: string, metadata: Record<string, unknown>) => staticMode
      ? rest(site, 'independent-audits', 'POST', { format: 'controlled-csv-v1', source, metadata })
      : legacy('import_independent_audit', { p_website_id: site, p_format: 'controlled-csv-v1', p_source: source, p_metadata: metadata }),
    save: (site: string, importId: string, deliveryId: string, asserted: boolean) => staticMode
      ? rest(site, 'independent-comparisons', 'POST', { import_id: importId, delivery_id: deliveryId, asserted, semantics: 's15-metadata-3' })
      : legacy('save_independent_comparison_versioned', { p_website_id: site, p_import_id: importId, p_delivery_id: deliveryId, p_asserted: asserted, p_semantics: 's15-metadata-3' }),
    remove: (site: string, confirmation: string, fingerprint: string) => staticMode
      ? rest(site, 'independent-evidence', 'DELETE', { confirmation, export_fingerprint: fingerprint })
      : legacy('delete_independent_audit_evidence', { p_website_id: site, p_confirmation: confirmation, p_export_fingerprint: fingerprint }),
    // The comparison writer also reads existing SEOsmith runs. Keep the legacy
    // Nitro calls and use the existing closed saved-report mapping in static mode.
    auditPath: (site: string, run?: string) => resolveSeosmithReadPath(`/api/websites/${site}/seo/audits${run ? `/${run}` : ''}`, staticMode, runtime.apiBaseUrl),
  }
}
