import { expect, it } from 'vitest'
import { auditPoints, auditValue, comparable, findingChanges, safeAuditUrl } from '../shared/utils/seosmith'
import type { AuditRun, AuditFinding, AuditPage } from '../shared/types/seosmith'
const measured = (...urls: string[]) => urls.map(url => ({ url, status: 200, error: null, blocked_by_robots: false, content_type: 'text/html', links: [], relationships: [] })) as AuditPage[]
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
  expect(findingChanges(b, a, [], old, measured('https://example.com/a'))).toEqual({ added: 0, resolved: 1, persistent: 0, unverified: 0 })
  expect(findingChanges(run('b', b.scan_at, false), a, [], old, [])).toBeNull()
  expect(findingChanges(run('b', b.scan_at, true, 'changed'), a, [], old, [])).toBeNull()
  expect(comparable({ ...a, summary: { ...a.summary, ruleset_version: null } }, b)).toBe(false)
})
it('compares rule plus affected URL rather than trusting changing provider finding IDs', () => {
  const a = run('a', '2026-10-31T01:00:00Z'), b = run('b', '2026-10-31T02:00:00Z')
  expect(findingChanges(a, b, [{ rule: 'broken', url: 'https://example.com', key: 'changed' }] as AuditFinding[], [{ rule: 'broken', url: 'https://example.com', key: 'previous' }] as AuditFinding[], measured('https://example.com'))).toEqual({ added: 0, resolved: 0, persistent: 1, unverified: 0 })
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
    expect(findingChanges({ ...a, summary: { ...a.summary, stop_reason } }, b, [], [{ rule: 'broken_resource', url: 'https://example.com/' }] as AuditFinding[], [])).toBeNull()
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
it('compares source metadata while leaving skipped navigation target findings unverified', () => {
  const current = run('new', '2026-11-01T02:00:00Z'), previous = run('old', '2026-11-01T01:00:00Z')
  const source = measured('https://example.com/')[0]!
  const target = 'https://outside.example/'
  source.links = [{ url: target, nofollow: false, text: 'External' }]
  source.relationships = [{ kind: 'navigation', url: target, descriptor: '', resource: false, state: 'outside_scope' }]
  const before = [
    { rule: 'missing_title', url: source.url, evidence: 'Empty' },
    { rule: 'external_link_broken', url: source.url, evidence: target, evidence_items: [target] },
    { rule: 'http_client_error', url: target, evidence: '404' },
  ] as AuditFinding[]
  expect(findingChanges(current, previous, [], before, [source])).toEqual({ added: 0, resolved: 1, persistent: 0, unverified: 2 })
  expect(findingChanges(current, previous, [], before, [source, ...measured(target)])).toEqual({ added: 0, resolved: 3, persistent: 0, unverified: 0 })
})
it.each(['nofollow', 'sponsored', 'ugc'])('does not resolve skipped %s targets but can resolve a removed link', rel => {
  const current = run('new', '2026-11-01T02:00:00Z'), previous = run('old', '2026-11-01T01:00:00Z')
  const source = measured('https://example.com/')[0]!, target = 'https://example.com/skipped'
  source.links = [{ url: target, nofollow: rel === 'nofollow', sponsored: rel === 'sponsored', ugc: rel === 'ugc', rel: [rel], text: 'Skipped' }]
  source.relationships = [{ kind: 'navigation', url: target, descriptor: rel, resource: false, state: 'not_fetched' }]
  const before = [{ rule: 'broken_internal_link', url: source.url, evidence: target, evidence_items: [target] }] as AuditFinding[]
  expect(findingChanges(current, previous, [], before, [source])?.unverified).toBe(1)
  source.links = []; source.relationships = []
  expect(findingChanges(current, previous, [], before, [source])?.resolved).toBe(1)
})
it('requires every previous target instance and an observed source before claiming resolution', () => {
  const current = run('new', '2026-11-01T02:00:00Z'), previous = run('old', '2026-11-01T01:00:00Z')
  const source = 'https://example.com/', a = 'https://cdn.example/a', b = 'https://cdn.example/b'
  const before = [{ rule: 'broken_resource', url: source, evidence: a, evidence_items: [a, b] }] as AuditFinding[]
  expect(findingChanges(current, previous, [], before, measured(source, a))?.unverified).toBe(1)
  expect(findingChanges(current, previous, [], before, measured(a, b))?.unverified).toBe(1)
  expect(findingChanges(current, previous, [], before, measured(source, a, b))?.resolved).toBe(1)
  const duplicateGroups = [...before, { ...before[0]!, evidence_items: ['https://cdn.example/c'] }]
  expect(findingChanges(current, previous, [], duplicateGroups, measured(source, a, b))?.unverified).toBe(1)
  const failed = measured(source, a, b); failed[2]!.error = 'failed'
  expect(findingChanges(current, previous, [], before, failed)?.unverified).toBe(1)
  const blocked = measured(source, a, b); blocked[2]!.blocked_by_robots = true
  expect(findingChanges(current, previous, [], before, blocked)?.unverified).toBe(1)
})
it('treats historical missing target evidence or source extraction as unknown', () => {
  const current = run('new', '2026-11-01T02:00:00Z'), previous = run('old', '2026-11-01T01:00:00Z')
  const source = measured('https://example.com/')[0]!
  const before = [{ rule: 'external_link_broken', url: source.url, evidence: 'Observed error' }] as AuditFinding[]
  expect(findingChanges(current, previous, [], before, [source])?.unverified).toBe(1)
  delete source.links; delete source.relationships
  before[0]!.evidence = 'https://outside.example/'
  expect(findingChanges(current, previous, [], before, [source])?.unverified).toBe(1)
})
it('requires observation of the current redirect chain, including targets beyond the old evidence', () => {
  const current = run('new', '2026-11-01T02:00:00Z'), previous = run('old', '2026-11-01T01:00:00Z')
  const [source, target] = measured('https://example.com/', 'https://example.com/redirected')
  source!.redirect = target!.url; target!.refresh_target = 'https://outside.example/'
  const before = [{ rule: 'redirect_loop', url: source!.url, evidence: source!.url }] as AuditFinding[]
  expect(findingChanges(current, previous, [], before, [source!, target!])?.unverified).toBe(1)
  expect(findingChanges(current, previous, [], before, [source!, target!, ...measured('https://outside.example/')])?.resolved).toBe(1)
})
