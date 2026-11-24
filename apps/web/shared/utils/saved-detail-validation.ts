import type { AuditDetail } from '../types/seosmith'

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const string = (v: unknown) => typeof v === 'string'
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const date = (v: unknown) => string(v) && Number.isFinite(Date.parse(v as string))
const strings = (v: Record<string, any>, keys: string[]) => keys.every(k => string(v[k]))
const numbers = (v: Record<string, any>, keys: string[]) => keys.every(k => number(v[k]))

// Validate fields read by the UI while retaining unsupported evidence versions.
export function isSavedDetail(value: unknown, id: string): value is AuditDetail {
  if (!object(value) || value.delivery_id !== id || !date(value.scan_at) || !date(value.received_at) || !string(value.ingestion_source) || (value.report_json != null && !string(value.report_json))) return false
  const s = value.summary, r = value.report
  if (!object(s) || !object(s.pages) || !object(s.severities) || !number(s.schema_version) || !string(s.outcome) || (s.stop_reason != null && !string(s.stop_reason)) || !numbers(s.pages, ['checked', 'html', 'images', 'http_errors', 'fetch_errors']) || !numbers(s.severities, ['critical', 'alert', 'warning'])) return false
  if (!object(r) || !object(r.request) || !Array.isArray(r.pages) || !Array.isArray(r.findings)) return false
  if (!r.pages.every((p: unknown) => object(p) && strings(p, ['url', 'content_type']) && (p.title == null || string(p.title)) && (p.bytes == null || number(p.bytes)) && (p.ttfb_ms == null || number(p.ttfb_ms)) && (p.status == null || number(p.status)))) return false
  if (!r.findings.every((f: unknown) => object(f) && strings(f, ['key', 'rule', 'severity', 'url', 'evidence']))) return false
  const e = r.evidence_contract
  if (r.schema_version === 2 && object(e) && e.version === 1) {
    if (!object(e.observed_at) || !strings(e.observed_at, ['started_at', 'finished_at']) || !object(e.policy) || !string(e.policy.signature) || !Array.isArray(e.coverage) || !Array.isArray(e.observations) || !Array.isArray(e.evaluations)) return false
    if (!e.coverage.every((c: unknown) => object(c) && string(c.rule) && object(c.unknown_reasons))) return false
    if (!e.observations.every((o: unknown) => object(o) && strings(o, ['source_locator', 'entity_id']))) return false
    if (!e.evaluations.every((v: unknown) => object(v) && strings(v, ['entity_id', 'rule']) && (v.finding_key == null || string(v.finding_key)) && (v.outcome !== 'fail' || (object(v.expected) && string(v.expected.state))))) return false
  }
  return true
}
