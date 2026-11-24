import { describe, expect, it } from 'vitest'
import { isSavedDetail } from '../shared/utils/saved-detail-validation'
import { findingEvaluation } from '../shared/utils/seosmith-remediation'
import type { AuditReport } from '../shared/types/seosmith'

const detail = () => ({
  delivery_id: 'run', scan_at: '2026-01-01T00:00:00Z', received_at: '2026-01-01T00:00:00Z', ingestion_source: 'import',
  summary: { schema_version: 2, outcome: 'partial', pages: { checked: 1, html: 1, images: 0, http_errors: 0, fetch_errors: 0 }, severities: { critical: 0, alert: 0, warning: 0 } },
  report: { schema_version: 2, request: {}, pages: [], findings: [], evidence_contract: { version: 99 } },
})

describe('saved detail validation', () => {
  it('keeps unsupported evidence available to the coverage panel', () => {
    const value = detail()
    expect(isSavedDetail(value, 'run')).toBe(true)
    expect(findingEvaluation(value.report as unknown as AuditReport, 0)).toBeUndefined()
  })
  it('rejects missing nested render fields and malformed supported evidence', () => {
    const value = detail()
    expect(isSavedDetail({ ...value, summary: { ...value.summary, pages: null } }, 'run')).toBe(false)
    expect(isSavedDetail({ ...value, report: { ...value.report, evidence_contract: { version: 1 } } }, 'run')).toBe(false)
    expect(isSavedDetail({ ...value, report: { ...value.report, pages: [{ url: 3 }] } }, 'run')).toBe(false)
  })
})
