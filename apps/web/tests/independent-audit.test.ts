import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { compareIndependent, parseControlledCsv } from '../shared/utils/independent-audit'

describe('S15 independent observations', () => {
  const csv = 'url,rule,state\nhttps://example.com/,missing_title,present\nhttps://example.com/,missing_description,absent\nhttps://example.com/,vendor_rule,unknown\n'
  const report = { schema_version: 1, engine_version: '0.2.0', ruleset_version: '2026-11-01.1', outcome: 'completed', coverage_complete: true, pages: [{ url: 'https://example.com/', status: 200, content_type: 'text/html', error: null, extraction_truncated: false }], findings: [{ url: 'https://example.com/', rule: 'missing_title' }] }
  it('reads the retained S15 controlled fixture including unknown and unmapped rows', () => {
    const rows = parseControlledCsv(readFileSync(new URL('./fixtures/s15-controlled.csv', import.meta.url), 'utf8'))
    expect(rows).toHaveLength(6)
    expect(rows[4]?.state).toBe('unknown')
    expect(rows[5]?.rule).toBe('other_rule')
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
  it('rejects duplicate and malformed rows and supports quoted fields', () => {
    expect(() => parseControlledCsv(csv + 'https://example.com/,missing_title,absent\n')).toThrow(/Duplicate/)
    expect(() => parseControlledCsv('url,rule,state\n"bad,rule,present')).toThrow(/Malformed/)
    expect(parseControlledCsv('url,rule,state\n"https://example.com/?a=1,b=2",x,unknown')[0]?.url).toContain(',')
  })
})
