import { describe, expect, it, vi } from 'vitest'
import { evidenceFamiliesUrl, loadEvidenceFamilies } from '../shared/utils/wire2-families-client'
import { FAMILY_KEYS } from '../shared/utils/wire2-families'

const site = '00000000-0000-0000-0000-000000000001'
const delivery = '00000000-0000-0000-0000-000000000002'
const base = 'https://api.example.test'
const CAPS: Record<string, [number, number]> = { s02_indexing: [256, 98304], s03_integrity: [256, 163840], s04_structured_data: [256, 131072], s05_link_graph: [256, 131072], s06_duplicates: [128, 98304], s08_resources: [256, 163840] }
const sec = (k: string) => ({ section_version: 1, semantics: 's', state: 'complete', reason: null, coverage: { entities: 0, eligible: 0, attempted: 0, observed: 0, unknown: 0, unknown_reasons: {} }, summary: {}, items: [], items_total: 0, omitted_items: 0, omitted_reason: null, truncated: false, max_items: CAPS[k]![0], max_bytes: CAPS[k]![1] })
const families = () => ({ version: 1, semantics: 's14-families-1', max_bytes: 786432, budget_state: 'within_budget', families: Object.fromEntries(FAMILY_KEYS.map(k => [k, sec(k)])) })
const body = (over = {}) => ({ delivery_id: delivery, wire_contract_version: 's14-wire-2', evidence_families: families(), reason: null, ...over })
const deps = (over: Record<string, unknown> = {}, fetcher = vi.fn().mockResolvedValue(body())) => ({ runtime: { apiBaseUrl: base, rolloutEvidenceFamilies: true, ...over }, accessToken: async () => 'tok', fetcher })

describe('evidenceFamiliesUrl', () => {
  it('is the owner read route on the API origin', () => {
    expect(evidenceFamiliesUrl(base, site, delivery)).toBe(`${base}/websites/${site}/seosmith/audits/${delivery}/evidence-families`)
  })
  it('refuses non-UUID ids', () => {
    expect(() => evidenceFamiliesUrl(base, '../x', delivery)).toThrow()
    expect(() => evidenceFamiliesUrl(base, site, `${delivery}/..`)).toThrow()
  })
})

describe('loadEvidenceFamilies', () => {
  it.each([undefined, false, 'true', 1])('flag %s: no request is made', async (flag) => {
    const d = deps({ rolloutEvidenceFamilies: flag })
    expect(await loadEvidenceFamilies(d, site, delivery)).toEqual({ kind: 'flag_off' })
    expect(d.fetcher).not.toHaveBeenCalled()
  })
  it('reads with the bearer, no redirects, no retries', async () => {
    const d = deps(), signal = new AbortController().signal
    const r = await loadEvidenceFamilies(d, site, delivery, signal)
    expect(r.kind).toBe('collected')
    expect(d.fetcher).toHaveBeenCalledWith(evidenceFamiliesUrl(base, site, delivery), expect.objectContaining({ headers: { Authorization: 'Bearer tok' }, redirect: 'error', retry: 0, signal }))
  })
  it('no session is unavailable, with no request', async () => {
    const d = { ...deps(), accessToken: async () => null }
    expect((await loadEvidenceFamilies(d, site, delivery)).kind).toBe('unavailable')
    expect(d.fetcher).not.toHaveBeenCalled()
  })
  it('maps a v1 audit to not_collected', async () => {
    const d = deps({}, vi.fn().mockResolvedValue(body({ wire_contract_version: 's14-wire-1', evidence_families: null, reason: 'not_collected' })))
    expect(await loadEvidenceFamilies(d, site, delivery)).toEqual({ kind: 'not_collected', wireContractVersion: 's14-wire-1' })
  })
  it('maps the API held-flag 503 to flag_off (ofetch data or response._data)', async () => {
    const held = { error: 'This feature is not available yet.' }
    expect(await loadEvidenceFamilies(deps({}, vi.fn().mockRejectedValue({ statusCode: 503, data: held })), site, delivery)).toEqual({ kind: 'flag_off' })
    expect(await loadEvidenceFamilies(deps({}, vi.fn().mockRejectedValue({ response: { status: 503, _data: held } })), site, delivery)).toEqual({ kind: 'flag_off' })
  })
  it('a 503 outage (or one with no readable body) is unavailable with retry, not held', async () => {
    for (const err of [{ statusCode: 503, data: { error: 'Websites are temporarily unavailable. Please try again.' } }, { statusCode: 503 }, { statusCode: 503, data: 'x' }]) {
      const r = await loadEvidenceFamilies(deps({}, vi.fn().mockRejectedValue(err)), site, delivery)
      expect(r.kind).toBe('unavailable')
    }
  })
  it('a 401 tells the user to sign in again', async () => {
    const r = await loadEvidenceFamilies(deps({}, vi.fn().mockRejectedValue({ statusCode: 401 })), site, delivery)
    expect(r).toEqual({ kind: 'unavailable', message: 'Sign in again to read evidence families.' })
  })
  it('maps 404 to not_found and others to unavailable (never to empty data)', async () => {
    expect((await loadEvidenceFamilies(deps({}, vi.fn().mockRejectedValue({ response: { status: 404 } })), site, delivery)).kind).toBe('not_found')
    expect((await loadEvidenceFamilies(deps({}, vi.fn().mockRejectedValue({ statusCode: 401 })), site, delivery)).kind).toBe('unavailable')
    expect((await loadEvidenceFamilies(deps({}, vi.fn().mockRejectedValue(new Error('network'))), site, delivery)).kind).toBe('unavailable')
  })
  it('refuses a malformed body and null families', async () => {
    const bad = deps({}, vi.fn().mockResolvedValue(body({ evidence_families: { ...families(), version: 9 } })))
    expect((await loadEvidenceFamilies(bad, site, delivery)).kind).toBe('invalid')
    const nul = deps({}, vi.fn().mockResolvedValue(body({ evidence_families: null })))
    expect((await loadEvidenceFamilies(nul, site, delivery)).kind).toBe('invalid')
  })
  it('an unusable API base URL is unavailable, not a throw', async () => {
    expect((await loadEvidenceFamilies(deps({ apiBaseUrl: '' }), site, delivery)).kind).toBe('unavailable')
  })
})
