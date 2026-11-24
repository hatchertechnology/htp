import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { compareIndependent, parseControlledCsv, normalizeProvenance, provenanceEntries, summarizeComparison, sourceByteLength, PROVENANCE_FIELDS } from '../shared/utils/independent-audit'

describe('S15 independent observations', () => {
  const csv = 'url,rule,state\nhttps://example.com/,missing_title,present\nhttps://example.com/,missing_description,absent\nhttps://example.com/,vendor_rule,unknown\n'
  const report = { schema_version: 1, engine_version: '0.2.0', ruleset_version: '2026-11-01.1', outcome: 'completed', stop_reason: 'frontier_exhausted', coverage_complete: true, pages: [{ url: 'https://example.com/', status: 200, content_type: 'text/html', error: null, is_resource: false, blocked_by_robots: false, flags: [], extraction_truncated: false }], findings: [{ url: 'https://example.com/', rule: 'missing_title' }] }
  it('reads the retained S15 controlled fixture including unknown and unmapped rows', () => {
    const rows = parseControlledCsv(readFileSync(new URL('./fixtures/s15-controlled.csv', import.meta.url), 'utf8'))
    expect(rows).toHaveLength(6)
    expect(rows[4]?.state).toBe('unknown')
    expect(rows[5]?.rule).toBe('other_rule')
  })
  it('pairs the controlled CSV with the pinned real S15 engine report', () => {
    const rows = parseControlledCsv(readFileSync(new URL('./fixtures/s15-controlled.csv', import.meta.url), 'utf8'))
    const actual = JSON.parse(readFileSync(new URL('./fixtures/s15-engine-report.json', import.meta.url), 'utf8'))
    expect(compareIndependent(rows, actual, true).slice(0, 6).map(x => x.category)).toEqual(['agreement', 'agreement', 'agreement', 'agreement', 'unknown', 'unmapped'])
    const page = actual.pages.find((p: {url: string}) => p.url === 'https://fixture.invalid/has-title')
    page.is_resource = true
    expect(compareIndependent(rows, actual, true)[1]?.seosmith).toBe('unknown')
    delete page.is_resource
    expect(compareIndependent(rows, actual, true)[1]?.seosmith).toBe('unknown')
  })
  it('compares only explicitly compatible observations and preserves unmapped rows', () => {
    expect(compareIndependent(parseControlledCsv(csv), report, true).map(x => x.category)).toEqual(['agreement', 'agreement', 'unmapped'])
    expect(compareIndependent(parseControlledCsv(csv.replace('missing_title,present', 'missing_title,absent')), report, true)[0]?.category).toBe('seosmith_only')
  })
  it('retains SEOsmith findings without independent observations as unknown', () => {
    const result = compareIndependent([], report, true)
    expect(result[0]).toMatchObject({ rule: 'missing_title', state: 'unknown', seosmith: 'present', category: 'unknown' })
  })
  it('keeps unavailable, partial and unasserted evidence unknown', () => {
    expect(compareIndependent(parseControlledCsv(csv), report, false)[0]?.category).toBe('unknown')
    expect(compareIndependent(parseControlledCsv(csv), { ...report, outcome: 'partial' }, true)[0]?.category).toBe('unknown')
    expect(compareIndependent(parseControlledCsv(csv), { ...report, pages: [] }, true)[0]?.category).toBe('unknown')
  })
  it('does not infer absence on resources or unknown resource classification', () => {
    for (const resource of [true, undefined]) {
      const pages = [{ ...report.pages[0]!, is_resource: resource }]
      expect(compareIndependent(parseControlledCsv(csv), { ...report, pages }, true)[1]?.seosmith).toBe('unknown')
    }
  })
  it('keeps stopped, blocked and limited evidence unknown', () => {
    const rows = parseControlledCsv(csv)
    for (const stop_reason of ['page_limit', 'extraction_limit', null, undefined]) expect(compareIndependent(rows, { ...report, stop_reason }, true)[1]?.seosmith).toBe('unknown')
    for (const change of [{ blocked_by_robots: true }, { blocked_by_robots: undefined }, { flags: ['extraction_limit'] }, { flags: ['discovery_limit'] }, { flags: ['legacy_checkpoint_metadata'] }, { flags: undefined }]) {
      expect(compareIndependent(rows, { ...report, pages: [{ ...report.pages[0]!, ...change }] }, true)[1]?.seosmith).toBe('unknown')
    }
  })
  it('enforces field and row bounds', () => {
    expect(() => parseControlledCsv(`url,rule,state\n${'a'.repeat(8193)},r,unknown`)).toThrow(/field exceeds/)
    expect(parseControlledCsv(`url,rule,state\n${'a'.repeat(8192)},r,unknown`)).toHaveLength(1)
    expect(() => parseControlledCsv('url,rule,state\n' + Array.from({ length: 34 }, (_, i) => `${'a'.repeat(8000)}${i},r,unknown\n`).join(''))).toThrow(/keys exceed/)
    expect(() => parseControlledCsv('url,rule,state\n' + Array.from({ length: 2001 }, (_, i) => `u${i},r,unknown\n`).join(''))).toThrow(/2,000/)
  })
  it('rejects unsupported stored semantics', () => {
    expect(() => compareIndependent([], report, true, 'future-version')).toThrow(/Unsupported comparison semantics/)
  })
  it('rejects duplicate and malformed rows and supports quoted fields', () => {
    expect(() => parseControlledCsv(csv + 'https://example.com/,missing_title,absent\n')).toThrow(/Duplicate/)
    expect(() => parseControlledCsv('url,rule,state\n"bad,rule,present')).toThrow(/Malformed/)
    expect(parseControlledCsv('url,rule,state\n"https://example.com/?a=1,b=2",x,unknown')[0]?.url).toContain(',')
  })
})

describe('realistic independent-tool export', () => {
  const raw = readFileSync(new URL('./fixtures/independent-tool-controlled.csv', import.meta.url))
  const rows = parseControlledCsv(raw.toString('utf8'))
  const report = JSON.parse(readFileSync(new URL('./fixtures/independent-tool-report.json', import.meta.url), 'utf8'))

  it('preserves the exact original bytes including CRLF and quoted fields', () => {
    expect(raw.byteLength).toBe(550)
    expect(raw.toString('utf8')).toContain('\r\n')
    expect(raw.toString('utf8')).toContain('"https://independent.example/query?a=1,b=2"')
    expect(sourceByteLength(raw.toString('utf8'))).toBe(raw.byteLength)
    expect(rows).toHaveLength(9)
  })

  it('produces complete discrepancy evidence for supported and unknown cases', () => {
    const result = compareIndependent(rows, report, true)
    expect(result.map(row => row.category)).toEqual([
      'agreement', 'agreement', 'unmapped', 'independent_only', 'seosmith_only',
      'unknown', 'unknown', 'unknown', 'independent_only', 'unknown',
    ])
    expect(summarizeComparison(result)).toEqual({ agreement: 2, independent_only: 2, seosmith_only: 1, unknown: 4, unmapped: 1, total: 10 })
  })

  it('keeps ineligible pages and resource classifications unknown rather than absent', () => {
    const result = compareIndependent(rows, report, true)
    expect(result.find(row => row.url === 'https://independent.example/ineligible')).toMatchObject({ seosmith: 'unknown', category: 'unknown' })
    expect(result.find(row => row.url === 'https://independent.example/resource')).toMatchObject({ seosmith: 'unknown', category: 'unknown' })
  })
})

describe('source provenance', () => {
  it('normalizes supplied fields and leaves missing fields explicit', () => {
    expect(normalizeProvenance({ tool: '  standalone crawler ', notes: '   ', version: undefined })).toEqual({ tool: 'standalone crawler' })
    const entries = provenanceEntries({ tool: 'standalone crawler' })
    expect(entries).toHaveLength(PROVENANCE_FIELDS.length)
    expect(entries.find(entry => entry.key === 'tool')?.value).toBe('standalone crawler')
    expect(entries.find(entry => entry.key === 'version')?.value).toBeNull()
    expect(provenanceEntries(null).every(entry => entry.value === null)).toBe(true)
  })

  it('preserves legacy free-text provenance instead of hiding it', () => {
    const entries = provenanceEntries('  Recorded before structured metadata; parser differences unknown.  ')
    expect(entries).toHaveLength(PROVENANCE_FIELDS.length + 1)
    expect(entries.find(entry => entry.key === 'legacy')).toMatchObject({ label: 'Legacy source note', value: 'Recorded before structured metadata; parser differences unknown.' })
    expect(entries.filter(entry => entry.key !== 'legacy').every(entry => entry.value === null)).toBe(true)
    expect(provenanceEntries('   ').some(entry => entry.key === 'legacy')).toBe(false)
  })

  it('bounds provenance to the receiver metadata limit', () => {
    expect(() => normalizeProvenance({ notes: 'x'.repeat(60_001) })).toThrow(/60 KiB/)
    expect(normalizeProvenance({ notes: 'x'.repeat(59_000) }).notes).toHaveLength(59_000)
  })
})
