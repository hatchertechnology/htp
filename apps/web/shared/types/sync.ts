export interface SyncStatus {
  coverage?: { state: 'complete' | 'partial' | 'unavailable'; observed_days: number; missing_dates: string[] } | null
  exact_range_available?: boolean
  observation_kind?: 'rolling_period' | 'lab_run' | null
  cadence?: 'hourly' | 'daily'
  state: 'pending' | 'ready' | 'stale' | 'error'
  fetched_at: string | null
  last_error: string | null
  next_run_at: string | null
  connection_status: 'connected' | 'reauthorization_required' | 'disconnected' | null
}
export interface PendingReport { code: 'report_pending'; error: string; sync: SyncStatus }
