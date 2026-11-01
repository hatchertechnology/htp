import { expect, it } from 'vitest'
import { auditPoints, auditValue, comparable, findingChanges, safeAuditUrl } from '../shared/utils/seosmith'
import type { AuditRun, AuditFinding } from '../shared/types/seosmith'
const run = (id: string, time: string, complete = true, key = 'same') => ({ delivery_id: id, scan_at: time, received_at: '2026-11-01T00:00:00Z', ingestion_source: 'worker', summary: { schema_version: 1, engine_version: '0.1.0', ruleset_version: 'v1', comparison_key: key, started_at: time, finished_at: time, outcome: complete ? 'completed' : 'partial', stop_reason: complete ? 'frontier_exhausted' : 'page_limit', coverage_complete: complete, pages: { checked: 10, html: 2, images: 8, http_errors: 0, fetch_errors: 0, blocked: 0 }, findings: 0, severities: { critical: 0, alert: 0, warning: 0 }, rules: {} } }) as AuditRun
it('keeps same-day and identical-time runs separate and plots by scan time rather than import date', () => {
  const rows = [run('b', '2026-10-31T01:00:00Z'), run('a', '2026-10-31T01:00:00Z'), run('c', '2026-10-31T02:00:00Z')]
  expect(auditPoints(rows, 'findings').map(x => x.run.delivery_id)).toEqual(['a', 'b', 'c'])
  expect(auditPoints(rows, 'findings').map(x => x.value)).toEqual([0, 0, 0])
  expect(auditPoints(rows, 'findings')[0]?.time).toBe(Date.parse('2026-10-31T01:00:00Z'))
})
it('refuses to label findings resolved across partial coverage or settings/engine changes', () => {
  const a = run('a', '2026-10-31T01:00:00Z'), b = run('b', '2026-10-31T02:00:00Z')
  const old = [{ rule: 'broken', url: 'https://example.com/a', key: 'old' }] as AuditFinding[]
  expect(comparable(a, b)).toBe(true)
  expect(findingChanges(b, a, [], old)).toEqual({ added: 0, resolved: 1, persistent: 0 })
  expect(findingChanges(run('b', b.scan_at, false), a, [], old)).toBeNull()
  expect(findingChanges(run('b', b.scan_at, true, 'changed'), a, [], old)).toBeNull()
  expect(comparable({ ...a, summary: { ...a.summary, ruleset_version: null } }, b)).toBe(false)
})
it('compares rule plus affected URL rather than trusting changing provider finding IDs', () => {
  const a = run('a', '2026-10-31T01:00:00Z'), b = run('b', '2026-10-31T02:00:00Z')
  expect(findingChanges(a, b, [{ rule: 'broken', url: 'https://example.com', key: 'changed' }] as AuditFinding[], [{ rule: 'broken', url: 'https://example.com', key: 'previous' }] as AuditFinding[])).toEqual({ added: 0, resolved: 0, persistent: 1 })
})
it('preserves zero counts, refuses invalid metrics and normalizes by measured URL count', () => {
  const r = run('a', '2026-10-31T01:00:00Z'); r.summary.findings = 5
  expect(auditValue(r, 'rate')).toBe(50)
  r.summary.pages.checked = 0; expect(auditValue(r, 'rate')).toBeNull()
  r.summary.findings = NaN; expect(auditValue(r, 'findings')).toBeNull()
})
it('never renders active non-HTTP links or credential-bearing URLs from imported content', () => {
  expect(safeAuditUrl('javascript:alert(1)')).toBeUndefined()
  expect(safeAuditUrl('https://user:pass@example.com/')).toBeUndefined()
  expect(safeAuditUrl('https://example.com/a')).toBe('https://example.com/a')
})
it('keeps reports with unknown original scan times out of the timestamp chart', () => {
  const r = run('a', '2026-10-31T01:00:00Z'); r.summary.finished_at = null
  expect(auditPoints([r], 'findings')).toEqual([])
})
it('refuses resource-limited or truncated runs even when coverage was claimed complete', () => {
  const a = run('a', '2026-10-31T01:00:00Z'), b = run('b', '2026-10-31T02:00:00Z')
  for (const stop_reason of ['resource_limit', 'legacy_checkpoint_metadata', 'discovery_or_extraction_limit']) {
    expect(findingChanges({ ...a, summary: { ...a.summary, stop_reason } }, b, [], [{ rule: 'broken_resource', url: 'https://example.com/' }] as AuditFinding[])).toBeNull()
  }
  for (const property of ['engine_version', 'ruleset_version'] as const) {
    expect(comparable({ ...a, summary: { ...a.summary, [property]: 'changed' } }, b)).toBe(false)
  }
})
it('retains repeated metadata and multi-instance evidence through the shared report contract', async () => {
  const { readFile } = await import('node:fs/promises')
  const fixture: import('../shared/types/seosmith').AuditReport = JSON.parse(await readFile(new URL('../../../supabase/tests/fixtures/seosmith-expanded.json', import.meta.url), 'utf8'))
  expect(fixture.pages[0]?.open_graph?.['og:image']).toEqual(['/a.webp', '/b.webp'])
  expect(fixture.pages[0]?.structured_data?.[2]?.format).toBe('microdata')
  expect(fixture.pages[0]?.relationships?.[0]?.kind).toBe('hreflang_header')
  expect(fixture.findings[0]?.evidence_items).toHaveLength(2)
  expect(fixture.request.max_resources).toBe(20000)
})
