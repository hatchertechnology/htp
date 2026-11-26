import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { compareIndependent, pageEntityId, sha256Hex, CURRENT_SEMANTICS, isSupportedSemantics, type Observation } from '../shared/utils/independent-audit'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/comparison-s4/${name}`, import.meta.url))
const load = (name: string) => JSON.parse(fixture(name).toString('utf8'))
const vectors = JSON.parse(readFileSync(new URL('../../../scripts/comparison-native/vectors.json', import.meta.url), 'utf8'))
const compare2 = (rows: Observation[], report: unknown, asserted = true) => compareIndependent(rows, report as never, asserted, 's15-metadata-2')
const both = (url: string): Observation[] => [{ url, rule: 'missing_title', state: 'absent' }, { url, rule: 'missing_description', state: 'absent' }]
const find = (rows: ReturnType<typeof compare2>, url: string, rule: string) => rows.find(r => r.url === url && r.rule === rule)!

describe('s15-metadata-2 (schema 4)', () => {
  it('is the current semantics and s15-metadata-1 stays supported', () => {
    expect(CURRENT_SEMANTICS).toBe('s15-metadata-2')
    expect(isSupportedSemantics('s15-metadata-1')).toBe(true)
    expect(isSupportedSemantics('s15-metadata-2')).toBe(true)
    expect(isSupportedSemantics('s15-metadata-3')).toBe(false)
  })

  it('pins the committed SEOsmith fixtures byte for byte', () => {
    for (const [name, sha] of Object.entries(vectors.fixtures as Record<string, string>)) expect(createHash('sha256').update(fixture(name)).digest('hex')).toBe(sha)
  })

  it('computes SEOsmith entity ids, and sha256, exactly', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc'.repeat(100))).toBe(createHash('sha256').update('abc'.repeat(100)).digest('hex'))
    expect(sha256Hex('日本語 é 😀'.repeat(40))).toBe(createHash('sha256').update('日本語 é 😀'.repeat(40)).digest('hex'))
    for (const v of vectors.entities) expect(pageEntityId(v.url)).toBe(v.entity_id)
  })

  it('reaches absent and present on crawl.json although evaluation_coverage_complete is false', () => {
    const report = load('crawl.json')
    expect(report.evidence_contract.evaluation_coverage_complete).toBe(false)
    expect(report.coverage_complete).toBe(true)
    expect(report.evidence_contract.truncated).toBe(false)
    const rows = compare2([...both('https://fixture.invalid/'), ...both('https://fixture.invalid/page-1'), ...both('https://fixture.invalid/not-in-report')], report)
    expect(find(rows, 'https://fixture.invalid/', 'missing_title')).toMatchObject({ seosmith: 'absent', category: 'agreement' })
    expect(find(rows, 'https://fixture.invalid/', 'missing_description')).toMatchObject({ seosmith: 'present', category: 'seosmith_only' })
    expect(find(rows, 'https://fixture.invalid/page-1', 'missing_title')).toMatchObject({ seosmith: 'present', category: 'seosmith_only' })
    expect(find(rows, 'https://fixture.invalid/page-1', 'missing_description')).toMatchObject({ seosmith: 'present' })
    expect(find(rows, 'https://fixture.invalid/not-in-report', 'missing_title')).toMatchObject({ seosmith: 'unknown', category: 'unknown', reason: 'no_evaluation' })
    expect(find(rows, 'https://fixture.invalid/not-in-report', 'missing_description')).toMatchObject({ seosmith: 'unknown', reason: 'no_evaluation' })
    // Every pinned vector row agrees with its table.
    for (const v of vectors.entities.filter((e: { fixture: string }) => e.fixture === 'crawl.json')) {
      const out = compare2(both(v.url), report)
      expect(out[0]!.seosmith).toBe(v.missing_title); expect(out[1]!.seosmith).toBe(v.missing_description)
    }
  })

  it('reports 18 absent and 6 present missing_title rows across the 24 crawl.json pages', () => {
    const report = load('crawl.json')
    const mapped = (rows: ReturnType<typeof compare2>) => rows.filter(r => r.rule === 'missing_title')
    const rows = mapped(compare2(report.pages.map((p: { url: string }) => ({ url: p.url, rule: 'missing_title', state: 'absent' as const })), report))
    expect(rows).toHaveLength(24)
    expect(rows.filter(r => r.seosmith === 'absent')).toHaveLength(18)
    expect(rows.filter(r => r.seosmith === 'present')).toHaveLength(6)
    expect(rows.filter(r => r.seosmith === 'unknown')).toHaveLength(0)
    // The independent source's observation never changes SEOsmith's own state.
    const flipped = mapped(compare2(report.pages.map((p: { url: string }) => ({ url: p.url, rule: 'missing_title', state: 'present' as const })), report))
    expect(flipped.map(r => r.seosmith)).toEqual(rows.map(r => r.seosmith))
  })

  it('never reports missing_description as absent, even for a pass evaluation', () => {
    const report = load('crawl.json')
    const forged = structuredClone(report)
    const id = pageEntityId('https://fixture.invalid/')
    const evaluation = forged.evidence_contract.evaluations.find((e: { entity_id: string; rule: string }) => e.entity_id === id && e.rule === 'missing_description')
    evaluation.outcome = 'pass'
    expect(find(compare2(both('https://fixture.invalid/'), forged), 'https://fixture.invalid/', 'missing_description')).toMatchObject({ seosmith: 'unknown', reason: 'absence_not_established' })
  })

  it('explains unknown with the per-rule coverage reason key and count', () => {
    const report = load('unicode.json')
    expect(report.evidence_contract.evaluation_coverage_complete).toBe(false)
    const url = 'https://example.com/%E6%97%A5%E6%9C%AC'
    const rows = compare2(both(url), report)
    expect(find(rows, url, 'missing_title')).toMatchObject({ seosmith: 'absent', category: 'agreement' })
    expect(find(rows, url, 'missing_description')).toMatchObject({ seosmith: 'unknown', category: 'unknown', reason: 'legacy_not_instrumented', reason_count: 6 })
    // The page that fails missing_title is present.
    expect(find(compare2([{ url: 'https://example.com/empty', rule: 'missing_title', state: 'present' }], report), 'https://example.com/empty', 'missing_title')).toMatchObject({ seosmith: 'present', category: 'agreement' })
  })

  it('turns a pass into unknown when the rule still carries unknown coverage', () => {
    const report = load('crawl.json')
    report.evidence_contract.coverage.find((c: { rule: string }) => c.rule === 'missing_title').unknown = 2
    report.evidence_contract.coverage.find((c: { rule: string }) => c.rule === 'missing_title').unknown_reasons = { source_unavailable: 2 }
    const rows = compare2(both('https://fixture.invalid/'), report)
    expect(find(rows, 'https://fixture.invalid/', 'missing_title')).toMatchObject({ seosmith: 'unknown', reason: 'source_unavailable', reason_count: 2 })
    // A fail is still a delivered finding.
    expect(find(compare2(both('https://fixture.invalid/page-1'), report), 'https://fixture.invalid/page-1', 'missing_title').seosmith).toBe('present')
  })

  it('makes every row unknown for partial-sources.json and mixed-caps-exceeded.json', () => {
    for (const name of ['partial-sources.json', 'mixed-caps-exceeded.json']) {
      const report = load(name)
      // Findings without a CSV row are appended as unmapped rows; only mapped rules carry an observation.
      const rows = compare2(report.pages.flatMap((p: { url: string }) => both(p.url)), report).filter(r => r.rule === 'missing_title' || r.rule === 'missing_description')
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every(r => r.seosmith === 'unknown' && r.category === 'unknown' && r.reason === 'report_not_comparable')).toBe(true)
    }
    expect(load('partial-sources.json').coverage_complete).toBe(false)
    expect(load('mixed-caps-exceeded.json').evidence_contract.truncated).toBe(true)
  })

  it('requires schema 4, evidence contract 1, a complete untruncated completed report and the assertion', () => {
    const report = load('crawl.json'), url = 'https://fixture.invalid/'
    const seosmith = (r: unknown, asserted = true) => find(compare2(both(url), r, asserted), url, 'missing_title').seosmith
    expect(seosmith(report)).toBe('absent')
    expect(seosmith(report, false)).toBe('unknown')
    expect(seosmith({ ...report, schema_version: 1 })).toBe('unknown')
    expect(seosmith({ ...report, schema_version: 5 })).toBe('unknown')
    expect(seosmith({ ...report, coverage_complete: false })).toBe('unknown')
    expect(seosmith({ ...report, outcome: 'partial' })).toBe('unknown')
    expect(seosmith({ ...report, evidence_contract: { ...report.evidence_contract, version: 2 } })).toBe('unknown')
    expect(seosmith({ ...report, evidence_contract: { ...report.evidence_contract, truncated: true } })).toBe('unknown')
    expect(seosmith({ ...report, evidence_contract: undefined })).toBe('unknown')
    expect(seosmith({ ...report, evidence_contract: { ...report.evidence_contract, evaluations: undefined } })).toBe('unknown')
  })

  it('treats duplicate evaluations and missing coverage as unknown, and leaves unmapped rules unmapped', () => {
    const report = load('crawl.json'), url = 'https://fixture.invalid/'
    const dup = structuredClone(report)
    dup.evidence_contract.evaluations.push(structuredClone(dup.evidence_contract.evaluations.find((e: { entity_id: string; rule: string }) => e.entity_id === pageEntityId(url) && e.rule === 'missing_title')))
    expect(find(compare2(both(url), dup), url, 'missing_title')).toMatchObject({ seosmith: 'unknown', reason: 'duplicate_evaluation' })
    const nocov = structuredClone(report)
    nocov.evidence_contract.coverage = nocov.evidence_contract.coverage.filter((c: { rule: string }) => c.rule !== 'missing_title')
    expect(find(compare2(both(url), nocov), url, 'missing_title')).toMatchObject({ seosmith: 'unknown', reason: 'no_coverage' })
    const unmapped = compare2([{ url, rule: 'vendor_rule', state: 'present' }], report)
    expect(unmapped.find(r => r.rule === 'vendor_rule')).toMatchObject({ category: 'unmapped', seosmith: 'unknown' })
  })

  it('keeps s15-metadata-1 frozen: a schema 4 report is not comparable there', () => {
    const report = load('crawl.json')
    expect(compareIndependent(both('https://fixture.invalid/'), report, true, 's15-metadata-1').every(r => r.seosmith === 'unknown')).toBe(true)
  })
})
