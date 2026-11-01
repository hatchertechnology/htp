export type Severity = 'critical' | 'alert' | 'warning'
export interface AuditObservationCounts {
  checked: number; html: number; images: number; http_errors: number; fetch_errors: number; blocked: number
}
export interface AuditSummary {
  summary_version?: number
  schema_version: number; engine_version: string | null; ruleset_version: string | null
  started_at: string | null; finished_at: string | null; outcome: string; stop_reason: string | null
  coverage_complete: boolean | null; comparison_key: string
  pages: AuditObservationCounts
  resources?: AuditObservationCounts
  findings: number; severities: Record<Severity, number>; rules: Record<string, number>
}
export interface AuditRun { delivery_id: string; scan_at: string; received_at: string; ingestion_source: 'worker' | 'import'; summary: AuditSummary }
export interface AuditHistory { items: AuditRun[]; has_more: boolean; next_cursor: { before: string; before_id: string } | null }
export interface AuditFinding {
  key: string; rule: string; severity: Severity; url: string; evidence: string
  evidence_items?: string[]
  details?: { status?: number | null; bytes?: number; ttfb_ms?: number; words?: number; dom_nodes?: number; observation_count?: number; [key: string]: unknown } | null
}
export interface AuditRelationship {
  kind: string; url: string; descriptor: string; resource: boolean
  state: 'checked' | 'blocked' | 'fetch_failed' | 'outside_scope' | 'not_fetched'
}
export interface AuditStructuredData { format: string; data: unknown; error: string | null }
// Additions are optional because historical schema-1 reports lack this evidence.
// Missing is_resource means a page; missing extraction arrays/maps mean no observations.
export interface AuditPage {
  url: string; status: number | null; error: string | null; blocked_by_robots: boolean
  content_type: string; bytes: number; ttfb_ms: number; title: string; in_sitemap: boolean
  depth?: number; description?: string; language?: string; robots?: string
  canonical?: string | null; header_canonical?: string | null; redirect?: string | null
  headings?: [number, string][]
  links?: { url: string; nofollow: boolean; sponsored?: boolean; ugc?: boolean; rel?: string[]; text: string }[]
  images?: { url: string; alt: string | null; width: boolean; height: boolean }[]
  alternates?: { language: string; url: string }[]
  body_hash?: string; words?: number; dom_nodes?: number; flags?: string[]
  is_resource?: boolean; encoding?: string; language_source?: string
  refresh_delay?: number | null; refresh_target?: string | null
  relationships?: AuditRelationship[]; structured_data?: AuditStructuredData[]
  open_graph?: Record<string, string[]>; twitter?: Record<string, string[]>
  extraction_truncated?: boolean
}
export interface AuditReport {
  schema_version?: number; engine_version?: string; ruleset_version?: string
  started_at?: string; finished_at?: string; outcome?: string; stop_reason?: string; coverage_complete?: boolean
  request: {
    url: string; max_pages: number; check_external_links: boolean
    max_resources?: number; request_id?: string; website_id?: string; binding_generation?: number
    max_duration_seconds?: number; delay_ms?: number
  }
  pages: AuditPage[]; findings: AuditFinding[]
}
export interface AuditDetail extends AuditRun { report_json?: string | null; report: AuditReport }
