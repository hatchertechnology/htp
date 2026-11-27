// Pins the web validator to the receiver: the 15 receiver positive reports
// (crates/s14-receiver/tests/fixtures/s14-wire2-v1/positive on w1c/wire-2-rx @ 2384151, the
// evidence_families member of each, compact-reserialised) must all validate and render, the
// §3.3 per-family caps are exact, and the boundary values the receiver enforces hold.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FAMILY_CAPS, FAMILY_KEYS, familyReasonText, sectionView, validateEvidenceFamilies } from '../shared/utils/wire2-families'

const dir = new URL('./fixtures/wire2-families-positive/', import.meta.url)
const names = readdirSync(dir).filter(n => n.endsWith('.json')).sort()
const load = (n: string) => JSON.parse(readFileSync(new URL(n, dir), 'utf8'))

const coverage = (over: Record<string, unknown> = {}) => ({ entities: 3, eligible: 3, attempted: 3, observed: 3, unknown: 0, unknown_reasons: {}, ...over })
const section = (key: keyof typeof FAMILY_CAPS, over: Record<string, unknown> = {}) => ({
  section_version: 1, semantics: 's14-x-1', state: 'complete', reason: null, coverage: coverage(), summary: {},
  items: [], items_total: 0, omitted_items: 0, omitted_reason: null, truncated: false,
  max_items: FAMILY_CAPS[key].maxItems, max_bytes: FAMILY_CAPS[key].maxBytes, ...over,
})
const item = (over: Record<string, unknown> = {}) => ({ entity_id: 'sha256:aa', locator: '/pages/1', kind: 'noindex', outcome: 'issue', reason: null, facts: { a: 1 }, ...over })
const doc = (patch: Partial<Record<keyof typeof FAMILY_CAPS, unknown>> = {}) => ({
  version: 1, semantics: 's14-families-1', max_bytes: 786432, budget_state: 'within_budget',
  families: Object.fromEntries(FAMILY_KEYS.map(k => [k, k in patch ? patch[k] : section(k)])),
})
const err = (v: unknown) => { const r = validateEvidenceFamilies(v); expect(r.ok).toBe(false); return (r as { error: string }).error }

describe('receiver positive fixtures', () => {
  it('has all 15 receiver positives', () => { expect(names).toHaveLength(15) })
  it.each(names)('%s validates and renders every family', (n) => {
    const r = validateEvidenceFamilies(load(n))
    expect(r.ok, r.ok ? '' : r.error).toBe(true)
    if (!r.ok) return
    for (const k of FAMILY_KEYS) {
      const s = r.value.families[k]
      expect(s.max_items).toBe(FAMILY_CAPS[k].maxItems)
      expect(s.max_bytes).toBe(FAMILY_CAPS[k].maxBytes)
      expect(sectionView(k, s).label).toBeTruthy()
    }
  })
})

describe('§3.3 per-family caps are exact', () => {
  it('the table is the design table', () => {
    expect(FAMILY_CAPS).toEqual({
      s02_indexing: { maxItems: 256, maxBytes: 98_304 }, s03_integrity: { maxItems: 256, maxBytes: 163_840 },
      s04_structured_data: { maxItems: 256, maxBytes: 131_072 }, s05_link_graph: { maxItems: 256, maxBytes: 131_072 },
      s06_duplicates: { maxItems: 128, maxBytes: 98_304 }, s08_resources: { maxItems: 256, maxBytes: 163_840 },
    })
    expect(Object.values(FAMILY_CAPS).reduce((a, c) => a + c.maxBytes, 0)).toBe(786_432)
  })
  it('accepts a producer-shaped S03 and S08 (163,840)', () => {
    expect(validateEvidenceFamilies(doc()).ok).toBe(true)
  })
  it.each(FAMILY_KEYS)('%s: wrong max_bytes or max_items (above or below) is refused', (k) => {
    const c = FAMILY_CAPS[k]
    for (const bytes of [c.maxBytes - 1, c.maxBytes + 1, 131_072 === c.maxBytes ? 98_304 : 131_072]) expect(err(doc({ [k]: section(k, { max_bytes: bytes }) }))).toMatch(new RegExp(`${k}.max_bytes must be ${c.maxBytes}`))
    for (const items of [c.maxItems - 1, c.maxItems + 1]) expect(err(doc({ [k]: section(k, { max_items: items }) }))).toMatch(new RegExp(`${k}.max_items must be ${c.maxItems}`))
  })
  it('s06 takes 128 items, not 256', () => {
    expect(err(doc({ s06_duplicates: section('s06_duplicates', { max_items: 256 }) }))).toMatch(/max_items must be 128/)
  })
  it('a section over its own max_bytes is refused (boundary)', () => {
    const big = section('s02_indexing', { summary: { s: 'x'.repeat(2000), t: 'x'.repeat(2000), u: 'x'.repeat(2000), v: 'x'.repeat(2000), w: 'x'.repeat(2000) } })
    expect(err(doc({ s02_indexing: big }))).toMatch(/summary is over 8192|larger than its max_bytes/)
    const items = Array.from({ length: 30 }, (_, i) => item({ locator: `/pages/${i}`, facts: { s: 'y'.repeat(2000), t: 'y'.repeat(1900) } }))
    expect(err(doc({ s02_indexing: section('s02_indexing', { items, items_total: 30 }) }))).toMatch(/larger than its max_bytes/)
  })
  it('the 786,432 total cap is exact', () => {
    expect(err({ ...doc(), max_bytes: 786_433 })).toMatch(/max_bytes/)
  })
  it('semantics is at most 64 bytes, as the receiver requires', () => {
    expect(validateEvidenceFamilies(doc({ s02_indexing: section('s02_indexing', { semantics: 's'.repeat(64) }) })).ok).toBe(true)
    expect(err(doc({ s02_indexing: section('s02_indexing', { semantics: 's'.repeat(65) }) }))).toMatch(/semantics/)
  })
  it('object keys over 2,048 bytes are refused; 2,048 passes', () => {
    expect(validateEvidenceFamilies(doc({ s02_indexing: section('s02_indexing', { items: [item({ facts: { ['k'.repeat(2048)]: 1 } })], items_total: 1 }) })).ok).toBe(true)
    expect(err(doc({ s02_indexing: section('s02_indexing', { items: [item({ facts: { ['k'.repeat(2049)]: 1 } })], items_total: 1 }) }))).toMatch(/key over/)
  })
  it('summary depth is not bounded (only facts depth is), as in the receiver', () => {
    expect(validateEvidenceFamilies(doc({ s02_indexing: section('s02_indexing', { summary: { a: { b: { c: { d: { e: { f: 1 } } } } } } }) })).ok).toBe(true)
  })
})

describe('own-property checks (prototype names)', () => {
  const protos = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']
  it.each(protos)('outcome %s is refused', (outcome) => {
    expect(err(doc({ s02_indexing: section('s02_indexing', { items: [item({ outcome })], items_total: 1 }) }))).toMatch(/outcome/)
  })
  it.each(protos)('reason code %s never renders function text', (c) => {
    expect(typeof familyReasonText(c)).toBe('string')
    expect(familyReasonText(c)).not.toMatch(/native code|\[object/)
    const s = validateEvidenceFamilies(doc({ s02_indexing: section('s02_indexing', { state: 'unavailable', reason: c }) }))
    if (s.ok) expect(sectionView('s02_indexing', s.value.families.s02_indexing).notice).not.toMatch(/native code|\[object/)
  })
  it('an unknown item with a prototype-named reason renders without throwing', () => {
    const r = validateEvidenceFamilies(doc({ s02_indexing: section('s02_indexing', { state: 'partial', coverage: coverage({ unknown: 1, unknown_reasons: { constructor: 1 } }), items: [item({ outcome: 'unknown', reason: 'constructor' })], items_total: 1 }) }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = sectionView('s02_indexing', r.value.families.s02_indexing)
    expect(v.rows[0]!.reason).toBe('Constructor')
    expect(v.unknownReasons[0]!.text).toBe('constructor')
  })
  it('a missing required key is not satisfied by an inherited name', () => {
    const s: any = section('s02_indexing'); delete s.items
    expect(err(doc({ s02_indexing: s }))).toMatch(/missing items/)
  })
})

describe('unknown items are bounded by coverage.unknown', () => {
  const unknownItem = (i: number) => item({ outcome: 'unknown', reason: 'robots_unavailable', locator: `/pages/${i}` })
  const part = (n: number, unknown: number) => section('s02_indexing', { state: 'partial', coverage: coverage({ unknown, unknown_reasons: unknown ? { robots_unavailable: unknown } : {} }), items: Array.from({ length: n }, (_, i) => unknownItem(i)), items_total: n })
  it('equal passes, one more is refused', () => {
    expect(validateEvidenceFamilies(doc({ s02_indexing: part(4, 4) })).ok).toBe(true)
    expect(validateEvidenceFamilies(doc({ s02_indexing: part(2, 4) })).ok).toBe(true)
    expect(err(doc({ s02_indexing: part(5, 4) }))).toMatch(/5 unknown items but coverage.unknown is 4/)
    expect(err(doc({ s02_indexing: part(2, 1) }))).toMatch(/2 unknown items/)
  })
})

describe('null sections', () => {
  it.each(FAMILY_KEYS)('%s: a null section is refused, never read as absent', (k) => {
    expect(err(doc({ [k]: null }))).toMatch(new RegExp(`${k} is null`))
  })
})
