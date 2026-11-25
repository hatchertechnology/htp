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
const optionalBoolean = (value: unknown) => value === undefined || value === null || typeof value === 'boolean'
const hasStrings = (record: RecordValue, keys: string[]) => keys.every(key => isString(record[key]))
const hasNumbers = (record: RecordValue, keys: string[]) => keys.every(key => isNumber(record[key]))
const observationCounts = (value: unknown) =>
  isRecord(value) && hasNumbers(value, ['checked', 'html', 'images', 'http_errors', 'fetch_errors'])

function isNumberMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isNumber)
}
function isRuleCoverageMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(row => isRecord(row) && isString(row.coverage) && isNumber(row.reported_findings))
}

/**
 * Schema-4 receiver summaries use a versioned shape. Version 5 keeps only the
 * severity keys that occur and adds record counts and per-rule coverage. An
 * unknown future version still validates its base shape so the dashboard can
 * state explicitly that it shows no versioned claims; the panel never reads
 * fields it did not verify.
 */
function isSchema4Summary(value: RecordValue): boolean {
  if (!isNumber(value.schema_version) || !isString(value.outcome) || !isRecord(value.pages)) return false
  if (!observationCounts(value.pages) || !optional(value.stop_reason, isString)) return false
  if (!optional(value.severities, isNumberMap) || !optional(value.summary_version, isNumber)) return false
  if (value.summary_version !== 5) return true
  return optional(value.audit_coverage, isString)
    && optional(value.wire_contract_version, isString)
    && optional(value.evidence_state, isString)
    && optional(value.evidence_contract_version, version => version === null || isNumber(version))
    && optionalBoolean(value.crawl_coverage_complete)
    && optionalBoolean(value.evaluation_coverage_complete)
    && optionalBoolean(value.coverage_complete)
    && optional(value.record_counts, isNumberMap)
    && optional(value.omitted_records, isNumber)
    && optional(value.omitted_observations, isNumber)
    && optional(value.rule_coverage, isRuleCoverageMap)
    && optional(value.resources, observationCounts)
    && optional(value.policy_digest, isString)
    && optional(value.manifest_digest, isString)
    && optional(value.scope_digest, isString)
    && optional(value.comparison_key, isString)
}

function isSummary(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.pages) || !isNumber(value.schema_version) || !isString(value.outcome)) return false
  if (value.schema_version === 4) return isSchema4Summary(value)
  // Legacy schemas 1/2 keep the exact previous contract.
  return isRecord(value.severities)
    && optional(value.stop_reason, isString)
    && hasNumbers(value.pages, ['checked', 'html', 'images', 'http_errors', 'fetch_errors'])
    && hasNumbers(value.severities, ['critical', 'alert', 'warning'])
}

function isPage(value: unknown): boolean {
  if (!isRecord(value)) return false
  // Historical reports can omit these display values.
  return optional(value.url, isString) && optional(value.content_type, isString)
    && optional(value.title, isString) && optional(value.bytes, isNumber)
    && optional(value.ttfb_ms, isNumber) && optional(value.status, isNumber)
}

function isFinding(value: unknown): boolean {
  return isRecord(value) && hasStrings(value, ['rule', 'severity', 'url'])
    && optional(value.key, isString) && optional(value.evidence, isString)
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
  return !((value.schema_version === 2 || value.schema_version === 4) && isRecord(evidence) && evidence.version === 1)
    || isKnownEvidence(evidence)
}

/** Check the fields read by the selected-detail UI, not the full report schema. */
export function isSavedDetail(value: unknown, id: string): value is AuditDetail {
  return isRecord(value) && value.delivery_id === id
    && isDate(value.scan_at) && isDate(value.received_at) && isString(value.ingestion_source)
    && optional(value.report_json, isString)
    && optional(value.summary_text, isString)
    && optional(value.summary_sha256, isString) && optional(value.summary_bytes, isNumber)
    && optional(value.source_sha256, isString) && optional(value.source_bytes, isNumber)
    && isSummary(value.summary) && isReport(value.report)
}
