/** Indexed S01 observations retain exact source pointers and only observed field digests. */
export interface UrlHistoryRow {
  delivery_id: string; scan_at: string; ingestion_source: 'worker' | 'import'
  evidence_state: string; schema_version: string | null; comparison_key: string | null
  policy_digest: string | null; engine_version: string | null; ruleset_version: string | null
  source_locator: string | null; unknown_reason: string | null; property_digests: Record<string,string> | null
}
export interface UrlHistoryDelta { state: 'changed' | 'unchanged_observed' | 'not_observed'; changed: string[]; unknown: string[] }
const fields = ['status','content_type','redirect','title','description','canonical','header_canonical','robots','language','body_hash','words','dom_nodes','headings','links','images','relationships','alternates','structured_data','open_graph','twitter']
/** Newest first, with consecutive server cursor pages; no removal is inferred. */
export function urlHistoryDeltas(rows: UrlHistoryRow[]): UrlHistoryDelta[] {
  return rows.map((current, index) => {
    const before=rows[index+1], now=current.property_digests, old=before?.property_digests
    if (!before || !(Date.parse(current.scan_at)>Date.parse(before.scan_at)) || current.evidence_state!=='available' || before.evidence_state!=='available'
      || (current.schema_version!=='2' && current.schema_version!=='4') || current.schema_version!==before.schema_version || !current.comparison_key || current.comparison_key!==before.comparison_key
      || !current.policy_digest || current.policy_digest!==before.policy_digest || !current.engine_version || current.engine_version!==before.engine_version
      || !current.ruleset_version || current.ruleset_version!==before.ruleset_version || !now || !old) return {state:'not_observed',changed:[],unknown:fields}
    const known=fields.filter(field=>typeof now[field]==='string' && typeof old[field]==='string')
    const unknown=fields.filter(field=>!known.includes(field))
    const changed=known.filter(field=>now[field]!==old[field])
    return {state:changed.length?'changed':known.length?'unchanged_observed':'not_observed',changed,unknown}
  })
}
