export type Severity = 'critical' | 'alert' | 'warning'
export interface AuditObservationCounts {
  checked: number; html: number; images: number; http_errors: number; fetch_errors: number; blocked: number
}
// Versioned coverage states emitted by the receiver for schema 4. Only a
// complete verified state reproduces the expected finding population; partial
// or absent evidence stays unknown and must never be read as clean.
export type AuditCoverageState = 'complete_verified' | 'unknown_partial'
// Record-level semantics that separate observations, advisories and explicit
// policy violations. Missing keys mean the receiver did not report a count.
export interface AuditRecordCounts {
  observation?: number
  advisory_triggered?: number
  advisory_not_triggered?: number
  violation?: number
  no_violation?: number
  not_applicable?: number
  unknown?: number
}
export interface AuditRuleCoverage {
  coverage: AuditCoverageState | string
  reported_findings: number
}
export interface AuditSummary {
  summary_version?: number
  evidence_contract_version?: 1 | null
  evidence_state?: 'legacy_unknown' | 'versioned' | 'policy_versioned' | 'unsupported'
  evaluation_coverage_complete?: boolean | null
  crawl_coverage_complete?: boolean
  evidence_truncated?: boolean; omitted_observations?: number; policy_digest?: string
  // Schema-4 receiver summary fields. Optional so legacy summaries stay valid.
  wire_contract_version?: string
  audit_coverage?: AuditCoverageState
  manifest_digest?: string; scope_digest?: string
  record_counts?: AuditRecordCounts
  omitted_records?: number
  rule_coverage?: Record<string, AuditRuleCoverage>
  schema_version: number; engine_version: string | null; ruleset_version: string | null
  started_at: string | null; finished_at: string | null; outcome: string; stop_reason: string | null
  coverage_complete: boolean | null; comparison_key: string
  pages: AuditObservationCounts
  resources?: AuditObservationCounts
  // Schema-4 summaries keep only the severities that occur, so zero severity
  // keys may be absent rather than explicitly zero.
  findings: number; severities: Partial<Record<Severity, number>>; rules: Record<string, number>
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
  evidence_contract?: AuditEvidenceContract
  schema_version?: number; engine_version?: string; ruleset_version?: string
  started_at?: string; finished_at?: string; outcome?: string; stop_reason?: string; coverage_complete?: boolean
  request: {
    url: string; max_pages: number; check_external_links: boolean
    max_resources?: number; request_id?: string; website_id?: string; binding_generation?: number
    max_duration_seconds?: number; delay_ms?: number
  }
  pages: AuditPage[]; findings: AuditFinding[]
}
export interface AuditDetail extends AuditRun {
  report_json?: string | null
  // Stored beside the parsed summary, never inside it. The text is the exact
  // opaque summary the receiver emitted; the digest and length bind those bytes.
  // Parsed JSON of the summary object cannot be treated as the receiver bytes:
  // PostgreSQL JSONB and normal object handling may reorder keys or numbers.
  summary_text?: string | null
  summary_sha256?: string
  summary_bytes?: number
  // Stored beside the summary, never inside it. They bind the summary to the
  // exact retained report bytes; the summary digest proves only the summary.
  source_sha256?: string
  source_bytes?: number
  report: AuditReport
}

/** Values are explicit: an empty known value is not unavailable evidence. */
export type AuditEvidenceValue =
  | { state: 'source'; source_locator: string }
  | { state: 'known'; value: string }
  | { state: 'unavailable'; reason: string }
export interface AuditEvidenceObservation {
  entity_id: string; source_locator: string
  state: 'available' | 'unavailable'; unknown_reason: string | null
}
export interface AuditEvaluation {
  entity_id: string; rule: string; rule_version: string; validator_version: string
  eligibility: 'eligible' | 'ineligible' | 'unknown'
  attempt: 'completed' | 'not_attempted' | 'unknown'
  outcome: 'pass' | 'fail' | 'not_applicable' | 'unknown'
  unknown_reason: string | null; source_locator: string
  actual: AuditEvidenceValue; expected: AuditEvidenceValue
  confidence: 'high' | 'unknown'; finding_key: string | null
}
export interface AuditRuleCoverage {
  rule: string; entities: number
  eligible: number; ineligible: number; eligibility_unknown: number
  attempted: number; not_attempted: number; attempt_unknown: number
  passed: number; failed: number; not_applicable: number; unknown: number
  unknown_reasons: Record<string, number>
}
export interface AuditReceiverCapabilities {
  receiver: 'htp'; schema_versions: number[]; max_report_bytes: number
  max_pages: number; max_resources: number; max_observations: number; max_findings: number
  exact_bytes: boolean; receipt_fields: string[]
}

export interface AuditEvidenceContract {
  version: 1
  /** signature is an unauthenticated SHA-256 digest of canonical_json bytes. */
  policy: { canonical_json: string; signature: string }
  comparison_key: string
  observed_at: { started_at: string; finished_at: string }
  observations: AuditEvidenceObservation[]; evaluations: AuditEvaluation[]
  coverage: AuditRuleCoverage[]; truncated: boolean; omitted_observations: number
  evaluation_coverage_complete: boolean
}
