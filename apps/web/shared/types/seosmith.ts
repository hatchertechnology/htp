export type Severity = 'critical' | 'alert' | 'warning'
export interface AuditSummary {
  schema_version: number; engine_version: string | null; ruleset_version: string | null
  started_at: string | null; finished_at: string | null; outcome: string; stop_reason: string | null
  coverage_complete: boolean | null; comparison_key: string
  pages: { checked: number; html: number; images: number; http_errors: number; fetch_errors: number; blocked: number }
  findings: number; severities: Record<Severity, number>; rules: Record<string, number>
}
export interface AuditRun { delivery_id: string; scan_at: string; received_at: string; ingestion_source: 'worker' | 'import'; summary: AuditSummary }
export interface AuditHistory { items: AuditRun[]; has_more: boolean; next_cursor: { before: string; before_id: string } | null }
export interface AuditFinding { key: string; rule: string; severity: Severity; url: string; evidence: string }
export interface AuditPage { url: string; status: number | null; error: string | null; blocked_by_robots: boolean; content_type: string; bytes: number; ttfb_ms: number; title: string; in_sitemap: boolean }
export interface AuditDetail extends AuditRun { report_json?: string | null; report: { request: { url: string; max_pages: number; check_external_links: boolean }; pages: AuditPage[]; findings: AuditFinding[] } }
