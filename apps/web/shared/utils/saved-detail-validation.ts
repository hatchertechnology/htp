import type { AuditDetail } from '../types/seosmith'

type RecordValue = Record<string, unknown>
const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const isDate = (value: unknown) => isString(value) && Number.isFinite(Date.parse(value))
const optional = (value: unknown, predicate: (value: unknown) => boolean) =>
  value == null || predicate(value)
const hasStrings = (record: RecordValue, keys: string[]) => keys.every(key => isString(record[key]))
const hasNumbers = (record: RecordValue, keys: string[]) => keys.every(key => isNumber(record[key]))

function isSummary(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.pages) || !isRecord(value.severities)) return false
  return isNumber(value.schema_version) && isString(value.outcome)
    && optional(value.stop_reason, isString)
    && hasNumbers(value.pages, ['checked', 'html', 'images', 'http_errors', 'fetch_errors'])
    && hasNumbers(value.severities, ['critical', 'alert', 'warning'])
}

function isPage(value: unknown): boolean {
  if (!isRecord(value) || !hasStrings(value, ['url', 'content_type'])) return false
  // Historical reports can omit these display values.
  return optional(value.title, isString) && optional(value.bytes, isNumber)
    && optional(value.ttfb_ms, isNumber) && optional(value.status, isNumber)
}

function isFinding(value: unknown): boolean {
  return isRecord(value) && hasStrings(value, ['key', 'rule', 'severity', 'url', 'evidence'])
}

function isKnownEvidence(value: RecordValue): boolean {
  if (!isRecord(value.observed_at) || !hasStrings(value.observed_at, ['started_at', 'finished_at'])) return false
  if (!isRecord(value.policy) || !isString(value.policy.signature)) return false
  if (!Array.isArray(value.coverage) || !Array.isArray(value.observations) || !Array.isArray(value.evaluations)) return false
  return value.coverage.every(row => isRecord(row) && isString(row.rule) && isRecord(row.unknown_reasons))
    && value.observations.every(row => isRecord(row) && hasStrings(row, ['source_locator', 'entity_id']))
    && value.evaluations.every(row => isRecord(row) && hasStrings(row, ['entity_id', 'rule'])
      && optional(row.finding_key, isString)
      && (row.outcome !== 'fail' || (isRecord(row.expected) && isString(row.expected.state))))
}

function isReport(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.request) || !Array.isArray(value.pages) || !Array.isArray(value.findings)) return false
  if (!value.pages.every(isPage) || !value.findings.every(isFinding)) return false
  const evidence = value.evidence_contract
  // Unknown versions stay available to the existing unsupported-evidence panel.
  return !(value.schema_version === 2 && isRecord(evidence) && evidence.version === 1)
    || isKnownEvidence(evidence)
}

/** Check the fields read by the selected-detail UI, not the full report schema. */
export function isSavedDetail(value: unknown, id: string): value is AuditDetail {
  return isRecord(value) && value.delivery_id === id
    && isDate(value.scan_at) && isDate(value.received_at) && isString(value.ingestion_source)
    && optional(value.report_json, isString) && isSummary(value.summary) && isReport(value.report)
}
