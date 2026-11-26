import { describe, expect, it } from 'vitest'
import { FAMILY_KEYS, parseFamiliesEnvelope, validateEvidenceFamilies } from '../shared/utils/wire2-families'

const DELIVERY = '00000000-0000-0000-0000-000000000002'
const coverage = (over: Record<string, unknown> = {}) => ({ entities: 3, eligible: 3, attempted: 3, observed: 3, unknown: 0, unknown_reasons: {}, ...over })
const section = (over: Record<string, unknown> = {}) => ({
  section_version: 1, semantics: 's14-s02-1', state: 'complete', reason: null, coverage: coverage(), summary: {},
  items: [], items_total: 0, omitted_items: 0, omitted_reason: null, truncated: false, max_items: 256, max_bytes: 131072, ...over,
})
const item = (over: Record<string, unknown> = {}) => ({ entity_id: 'sha256:aa', locator: '/pages/1', kind: 'noindex', outcome: 'issue', reason: null, facts: { a: 1 }, ...over })
const families = (over: Record<string, unknown> = {}) => ({
  version: 1, semantics: 's14-families-1', max_bytes: 786432, budget_state: 'within_budget',
  families: Object.fromEntries(FAMILY_KEYS.map(k => [k, section()])), ...over,
})
const withSection = (key: string, s: unknown) => { const f = families(); (f.families as any)[key] = s; return f }
const refused = (v: unknown) => { const r = validateEvidenceFamilies(v); expect(r.ok).toBe(false); return (r as { ok: false; error: string }).error }

describe('validateEvidenceFamilies', () => {
  it('accepts a complete six-family object', () => {
    expect(validateEvidenceFamilies(families()).ok).toBe(true)
  })
  it('rejects null and non-objects, never reading them as absent', () => {
    expect(refused(null)).toMatch(/null/i)
    expect(refused([])).toMatch(/object/i)
    expect(refused('x')).toMatch(/object/i)
  })
  it('requires version 1, the semantics label, the byte cap and a known budget state', () => {
    expect(refused(families({ version: 2 }))).toMatch(/version/)
    expect(refused(families({ semantics: 'other' }))).toMatch(/semantics/)
    expect(refused(families({ max_bytes: 1 }))).toMatch(/max_bytes/)
    expect(refused(families({ budget_state: 'weird' }))).toMatch(/budget_state/)
    expect(validateEvidenceFamilies(families({ budget_state: 'report_byte_budget' })).ok).toBe(true)
  })
  it('rejects unknown keys at every level', () => {
    expect(refused(families({ extra: 1 }))).toMatch(/extra/)
    const f = families(); (f.families as any).s99_extra = section(); expect(refused(f)).toMatch(/s99_extra/)
    expect(refused(withSection('s02_indexing', section({ extra: 1 })))).toMatch(/extra/)
    expect(refused(withSection('s02_indexing', section({ coverage: coverage({ extra: 1 }) })))).toMatch(/extra/)
    expect(refused(withSection('s02_indexing', section({ items: [item({ extra: 1 })], items_total: 1 })))).toMatch(/extra/)
  })
  it('requires all six family keys', () => {
    const f = families(); delete (f.families as any).s05_link_graph
    expect(refused(f)).toMatch(/s05_link_graph/)
  })
  it('invariant 1: items_total = items.length + omitted_items', () => {
    expect(refused(withSection('s02_indexing', section({ items: [item()], items_total: 5 })))).toMatch(/items_total/)
  })
  it('invariant 2: truncated exactly when omitted_items > 0, with a known reason', () => {
    expect(refused(withSection('s02_indexing', section({ items_total: 4, omitted_items: 4, truncated: false, omitted_reason: 'family_item_limit', state: 'partial', coverage: coverage({ unknown: 4, unknown_reasons: { family_item_limit: 4 } }) })))).toMatch(/truncated/)
    expect(refused(withSection('s02_indexing', section({ truncated: true })))).toMatch(/truncated/)
    expect(refused(withSection('s02_indexing', section({ items_total: 4, omitted_items: 4, truncated: true, omitted_reason: null, state: 'partial' })))).toMatch(/omitted_reason/)
    expect(refused(withSection('s02_indexing', section({ items_total: 4, omitted_items: 4, truncated: true, omitted_reason: 'nope', state: 'partial' })))).toMatch(/omitted_reason/)
    expect(refused(withSection('s02_indexing', section({ omitted_reason: 'family_item_limit' })))).toMatch(/omitted_reason/)
  })
  it('accepts a truncated partial section', () => {
    const s = section({ state: 'partial', items: [item()], items_total: 4, omitted_items: 3, truncated: true, omitted_reason: 'family_byte_budget' })
    expect(validateEvidenceFamilies(withSection('s02_indexing', s)).ok).toBe(true)
  })
  it('invariant 3: complete needs no unknowns and no truncation', () => {
    expect(refused(withSection('s02_indexing', section({ coverage: coverage({ unknown: 1, unknown_reasons: { robots_unavailable: 1 } }) })))).toMatch(/complete/)
    expect(refused(withSection('s02_indexing', section({ items_total: 2, omitted_items: 2, truncated: true, omitted_reason: 'family_item_limit' })))).toMatch(/complete/)
  })
  it('invariant 3: unavailable needs empty items and a reason', () => {
    expect(refused(withSection('s02_indexing', section({ state: 'unavailable', reason: null })))).toMatch(/reason/)
    expect(refused(withSection('s02_indexing', section({ state: 'unavailable', reason: 'analyzer_error', items: [item()], items_total: 1 })))).toMatch(/unavailable/)
    expect(validateEvidenceFamilies(withSection('s02_indexing', section({ state: 'unavailable', reason: 'analyzer_error' }))).ok).toBe(true)
  })
  it('invariant 4: unknown outcome needs a reason; unknown_reasons sum to unknown', () => {
    const partial = { state: 'partial', coverage: coverage({ unknown: 1, unknown_reasons: { robots_unavailable: 1 } }) }
    expect(refused(withSection('s02_indexing', section({ ...partial, items: [item({ outcome: 'unknown', reason: null })], items_total: 1 })))).toMatch(/reason/)
    expect(validateEvidenceFamilies(withSection('s02_indexing', section({ ...partial, items: [item({ outcome: 'unknown', reason: 'robots_unavailable' })], items_total: 1 }))).ok).toBe(true)
    expect(refused(withSection('s02_indexing', section({ state: 'partial', coverage: coverage({ unknown: 2, unknown_reasons: { robots_unavailable: 1 } }) })))).toMatch(/unknown_reasons/)
  })
  it('invariant 4: a capture omission is never a pass', () => {
    for (const reason of ['collector_byte_limit', 'run_byte_limit'])
      expect(refused(withSection('s02_indexing', section({ state: 'partial', coverage: coverage({ unknown: 1, unknown_reasons: { [reason]: 1 } }), items: [item({ outcome: 'pass', reason })], items_total: 1 })))).toMatch(/pass/)
  })
  it('invariant 5: locator shape, and entity_id/locator pairing', () => {
    for (const locator of ['/pages/1', '/pages/12/links/3', '/pages/2/relationships/0'])
      expect(validateEvidenceFamilies(withSection('s03_integrity', section({ items: [item({ locator })], items_total: 1 }))).ok).toBe(true)
    for (const locator of ['/pages/x', '/page/1', '/pages/1/other/2', 'http://x', '/pages/-1', '/pages/1/links'])
      expect(refused(withSection('s03_integrity', section({ items: [item({ locator })], items_total: 1 })))).toMatch(/locator/)
    expect(refused(withSection('s03_integrity', section({ items: [item({ locator: null })], items_total: 1 })))).toMatch(/entity_id/)
    expect(validateEvidenceFamilies(withSection('s03_integrity', section({ items: [item({ locator: null, entity_id: null, facts: { url: 'https://a.test/' } })], items_total: 1 }))).ok).toBe(true)
    expect(refused(withSection('s03_integrity', section({ items: [item({ locator: null, entity_id: null, facts: {} })], items_total: 1 })))).toMatch(/url/)
  })
  it('invariant 6: code shapes, facts bounds, no NUL', () => {
    expect(refused(withSection('s02_indexing', section({ items: [item({ kind: 'Bad Kind' })], items_total: 1 })))).toMatch(/kind/)
    expect(refused(withSection('s02_indexing', section({ state: 'unavailable', reason: 'X Y' })))).toMatch(/reason/)
    expect(refused(withSection('s02_indexing', section({ items: [item({ facts: { a: { b: { c: { d: { e: 1 } } } } } })], items_total: 1 })))).toMatch(/depth/)
    expect(refused(withSection('s02_indexing', section({ items: [item({ facts: { s: 'x'.repeat(2049) } })], items_total: 1 })))).toMatch(/string/)
    expect(refused(withSection('s02_indexing', section({ items: [item({ facts: { s: 'a\u0000b' } })], items_total: 1 })))).toMatch(/NUL/)
    expect(refused(withSection('s02_indexing', section({ items: [item({ facts: Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`k${i}`, 'y'.repeat(1500)])) })], items_total: 1 })))).toMatch(/4096/)
    expect(refused(withSection('s02_indexing', section({ summary: { s: 'z'.repeat(8193) } })))).toMatch(/summary/)
  })
  it('invariant 7: items are in deterministic order', () => {
    const items = [item({ outcome: 'pass', locator: '/pages/1' }), item({ outcome: 'issue', locator: '/pages/2' })]
    expect(refused(withSection('s02_indexing', section({ items, items_total: 2 })))).toMatch(/order/)
    const ok = [item({ outcome: 'issue', locator: '/pages/2' }), item({ outcome: 'pass', locator: '/pages/1' })]
    expect(validateEvidenceFamilies(withSection('s02_indexing', section({ items: ok, items_total: 2 }))).ok).toBe(true)
  })
  it('rejects non-integer and negative counts, and items over max_items', () => {
    expect(refused(withSection('s02_indexing', section({ coverage: coverage({ entities: -1 }) })))).toMatch(/entities/)
    expect(refused(withSection('s02_indexing', section({ coverage: coverage({ observed: 1.5 }) })))).toMatch(/observed/)
    expect(refused(withSection('s02_indexing', section({ max_items: 3, items: Array.from({ length: 4 }, (_, i) => item({ locator: `/pages/${i}` })), items_total: 4 })))).toMatch(/max_items/)
  })
})

describe('parseFamiliesEnvelope', () => {
  const env = (over: Record<string, unknown> = {}) => ({ delivery_id: DELIVERY, wire_contract_version: 's14-wire-2', evidence_families: families(), reason: null, ...over })
  it('returns collected families', () => {
    const r = parseFamiliesEnvelope(env(), DELIVERY)
    expect(r.kind).toBe('collected')
  })
  it('maps a v1 audit to not_collected', () => {
    const r = parseFamiliesEnvelope(env({ wire_contract_version: 's14-wire-1', evidence_families: null, reason: 'not_collected' }), DELIVERY)
    expect(r).toEqual({ kind: 'not_collected', wireContractVersion: 's14-wire-1' })
  })
  it('refuses a null families value without the not_collected reason', () => {
    expect(parseFamiliesEnvelope(env({ evidence_families: null, reason: null }), DELIVERY).kind).toBe('invalid')
  })
  it('refuses families together with a not_collected reason', () => {
    expect(parseFamiliesEnvelope(env({ reason: 'not_collected' }), DELIVERY).kind).toBe('invalid')
  })
  it('refuses a different delivery, bad envelope keys and non-objects', () => {
    expect(parseFamiliesEnvelope(env({ delivery_id: '00000000-0000-0000-0000-000000000009' }), DELIVERY).kind).toBe('invalid')
    expect(parseFamiliesEnvelope(env({ extra: 1 }), DELIVERY).kind).toBe('invalid')
    expect(parseFamiliesEnvelope(null, DELIVERY).kind).toBe('invalid')
  })
  it('refuses malformed families with the validator message', () => {
    const r = parseFamiliesEnvelope(env({ evidence_families: families({ version: 3 }) }), DELIVERY)
    expect(r.kind).toBe('invalid')
    expect((r as { message: string }).message).toMatch(/version/)
  })
})

import { FAMILY_LABELS, familyFactsText, panelNotice, familyReasonText, sectionView } from '../shared/utils/wire2-families'
describe('view model', () => {
  const sec = (over: Record<string, unknown> = {}) => section(over) as any
  it('labels all six families', () => {
    expect(FAMILY_KEYS.map(k => FAMILY_LABELS[k])).toEqual(['Indexing', 'Integrity', 'Structured data', 'Link graph', 'Duplicates', 'Resources'])
  })
  it('panelNotice covers every non-collected state with distinct, honest text', () => {
    const states = [
      panelNotice({ kind: 'loading' }), panelNotice({ kind: 'flag_off' }), panelNotice({ kind: 'not_collected', wireContractVersion: 's14-wire-1' }),
      panelNotice({ kind: 'not_found' }), panelNotice({ kind: 'unavailable', message: 'Down.' }), panelNotice({ kind: 'invalid', message: 'bad thing' }),
    ]
    expect(new Set(states.map(s => s.text)).size).toBe(6)
    expect(states[1]!.text).toMatch(/not available yet/i)
    expect(states[2]!.text).toMatch(/before|not collected|older/i)
    expect(states[2]!.text).not.toMatch(/\b0\b|no issues|none found/i)
    expect(states[5]!.text).toMatch(/bad thing/)
    expect(states[5]!.tone).toBe('error')
    expect(panelNotice({ kind: 'collected', families: families() as any, wireContractVersion: 's14-wire-2' }).text).toBe('')
  })
  it('a budget-degraded report says so', () => {
    expect(panelNotice({ kind: 'collected', families: families({ budget_state: 'report_byte_budget' }) as any, wireContractVersion: 's14-wire-2' }).text).toMatch(/size budget/i)
  })
  it('a complete section shows its counts', () => {
    const v = sectionView('s02_indexing', sec())
    expect(v.stateLabel).toBe('Complete')
    expect(v.counts.map(c => c.label)).toEqual(['Entities', 'Eligible', 'Attempted', 'Observed', 'Unknown'])
    expect(v.counts.find(c => c.label === 'Unknown')!.value).toBe('0')
    expect(v.notice).toBeNull()
  })
  it('an unavailable section never shows counts as zero', () => {
    const v = sectionView('s05_link_graph', sec({ state: 'unavailable', reason: 'analyzer_error' }))
    expect(v.stateLabel).toBe('Unavailable')
    expect(v.counts).toEqual([])
    expect(v.notice).toMatch(/not collected|unavailable/i)
    expect(v.notice).toMatch(/analyzer/i)
  })
  it('a partial section lists why entities are unknown', () => {
    const v = sectionView('s02_indexing', sec({ state: 'partial', coverage: coverage({ unknown: 3, unknown_reasons: { robots_unavailable: 2, collector_byte_limit: 1 } }) }))
    expect(v.stateLabel).toBe('Partial')
    expect(v.notice).toMatch(/3 .*could not be determined/)
    expect(v.unknownReasons.map(r => r.count)).toEqual([2, 1])
  })
  it('a truncated section states shown, total and why', () => {
    const v = sectionView('s03_integrity', sec({ state: 'partial', items: [item()], items_total: 5, omitted_items: 4, truncated: true, omitted_reason: 'family_item_limit' }))
    expect(v.truncation).toMatch(/1 of 5/)
    expect(v.truncation).toMatch(/4 .*omitted/)
  })
  it('an unknown item shows Unknown and its reason, never a pass or zero', () => {
    const v = sectionView('s02_indexing', sec({ state: 'partial', coverage: coverage({ unknown: 1, unknown_reasons: { run_byte_limit: 1 } }), items: [item({ outcome: 'unknown', reason: 'run_byte_limit' })], items_total: 1 }))
    expect(v.rows[0]!.outcome).toBe('Unknown')
    expect(v.rows[0]!.reason).toMatch(/size limit/i)
  })
  it('familyReasonText keeps unrecognised codes readable', () => {
    expect(familyReasonText('some_new_code')).toBe('some new code')
    expect(familyReasonText(null)).toBe('')
  })
  it('familyFactsText is bounded and stable', () => {
    expect(familyFactsText({ b: 2, a: 'x' })).toBe('a: x · b: 2')
    expect(familyFactsText({ s: 'y'.repeat(500) }).length).toBeLessThan(200)
    expect(familyFactsText({})).toBe('')
  })
})
