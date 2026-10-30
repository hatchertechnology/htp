export interface SyncStatus {
  state: 'pending' | 'ready' | 'stale' | 'error'
  fetched_at: string | null
  last_error: string | null
  next_run_at: string
  connection_status: 'connected' | 'reauthorization_required' | 'disconnected' | null
}
export interface PendingReport { code: 'report_pending'; error: string; sync: SyncStatus }
