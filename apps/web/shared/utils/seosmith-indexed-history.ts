/** Read-time transitions over a contiguous page chain of saved evaluations. */
export interface IndexedHistoryRow {
  delivery_id: string; scan_at: string; ingestion_source: 'worker' | 'import'; evidence_state: string
  comparison_key: string | null; schema_version: string | null; engine_version: string | null; ruleset_version: string | null; policy_digest: string | null
  evaluation: { outcome: string; eligibility: string; attempt: string; rule_version: string; validator_version: string; source_locator: string; finding_digest: string | null } | null
}
export type IndexedTransition = 'new' | 'persisting' | 'changed' | 'resolved' | 'reopened' | 'not_observed' | 'no_finding'
function complete(row: IndexedHistoryRow | undefined) {
  const e = row?.evaluation
  return row?.evidence_state === 'evaluated' && !!e && e.eligibility === 'eligible' && e.attempt === 'completed' && (e.outcome === 'fail' || e.outcome === 'pass')
}
function compatible(a: IndexedHistoryRow, b: IndexedHistoryRow) {
  return (a.schema_version === '2' || a.schema_version === '4') && a.schema_version === b.schema_version && !!a.comparison_key && a.comparison_key === b.comparison_key
    && !!a.policy_digest && a.policy_digest === b.policy_digest && !!a.engine_version && a.engine_version === b.engine_version
    && !!a.ruleset_version && a.ruleset_version === b.ruleset_version && a.evaluation?.rule_version === b.evaluation?.rule_version
    && a.evaluation?.validator_version === b.evaluation?.validator_version
}
/** Items must be newest first, without skipping a cursor page. Missing pages cannot establish a transition. */
export function indexedTransitions(rows: IndexedHistoryRow[], hasMore: boolean): IndexedTransition[] {
  return rows.map((current, index) => {
    const before = rows[index + 1]
    if (!before || !(Date.parse(current.scan_at) > Date.parse(before.scan_at)) || !complete(current) || !complete(before) || !compatible(current, before)) return 'not_observed'
    const now = current.evaluation!, old = before.evaluation!
    if (old.outcome === 'fail' && now.outcome === 'pass') return 'resolved'
    if (old.outcome === 'pass' && now.outcome === 'pass') return 'no_finding'
    if (old.outcome === 'fail' && now.outcome === 'fail') return !old.finding_digest || !now.finding_digest ? 'not_observed' : old.finding_digest === now.finding_digest ? 'persisting' : 'changed'
    const older = rows.slice(index + 2)
    if (older.some(row => complete(row) && row.evaluation!.outcome === 'fail' && compatible(current, row))) return 'reopened'
    // The adjacent pass establishes new since that baseline; a missing earlier
    // page or unknown history cannot establish whether an older failure existed.
    if (hasMore || older.some(row => !complete(row) || !compatible(current, row))) return 'not_observed'
    return 'new'
  })
}
