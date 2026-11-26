// Exercises the real EvidenceFamilies.vue script (no browser): every state the
// panel can be in, stale-response handling, and the template's wiring.
import { readFileSync } from 'node:fs'
import { transpile } from 'typescript'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { expect, it, vi } from 'vitest'
import * as lib from '../shared/utils/wire2-families'
import * as client from '../shared/utils/wire2-families-client'
import { parse } from 'vue/compiler-sfc'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'

const site = '00000000-0000-0000-0000-000000000001', d1 = '00000000-0000-0000-0000-000000000002', d2 = '00000000-0000-0000-0000-000000000003'
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const vue = read('../app/components/EvidenceFamilies.vue')
const script = vue.split('<script setup lang="ts">')[1]!.split('</script>')[0]!.replace(/^import .*$/gm, '')
const make = new Function('deps', `const {ref,computed,watch,onBeforeUnmount,defineProps,useRuntimeConfig,useAuth,$fetch,lib,client}=deps\nconst {FAMILY_KEYS,panelNotice,sectionView}=lib\nconst {loadEvidenceFamilies}=client\n${transpile(script, { target: 99 })}\nreturn { state, notice, sections, load, generation: () => generation }`)
const CAPS: Record<string, [number, number]> = { s02_indexing: [256, 98304], s03_integrity: [256, 163840], s04_structured_data: [256, 131072], s05_link_graph: [256, 131072], s06_duplicates: [128, 98304], s08_resources: [256, 163840] }
const sec = (k: string) => ({ section_version: 1, semantics: 's', state: 'complete', reason: null, coverage: { entities: 2, eligible: 2, attempted: 2, observed: 2, unknown: 0, unknown_reasons: {} }, summary: {}, items: [], items_total: 0, omitted_items: 0, omitted_reason: null, truncated: false, max_items: CAPS[k]![0], max_bytes: CAPS[k]![1] })
const families = () => ({ version: 1, semantics: 's14-families-1', max_bytes: 786432, budget_state: 'within_budget', families: Object.fromEntries(lib.FAMILY_KEYS.map(k => [k, sec(k)])) })
const body = (delivery = d1, over = {}) => ({ delivery_id: delivery, wire_contract_version: 's14-wire-2', evidence_families: families(), reason: null, ...over })

function mount(runtime: Record<string, unknown>, fetch: (u: string, o: any) => Promise<unknown>, props = reactive({ websiteId: site, deliveryId: d1 })) {
  const unmount: Array<() => void> = []
  const api = make({ ref, computed, watch, onBeforeUnmount: (f: () => void) => unmount.push(f), defineProps: () => props, useRuntimeConfig: () => ({ public: { apiBaseUrl: 'https://api.example.test', ...runtime } }), useAuth: () => ({ accessToken: async () => 'tok' }), $fetch: fetch, lib, client })
  return { api, props, unmount: () => unmount.forEach(f => f()) }
}
const settle = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick() } }

it('shows loading first, then the six collected families', async () => {
  let release!: (v: unknown) => void
  const m = mount({ rolloutEvidenceFamilies: true }, () => new Promise(r => { release = r }))
  expect(m.api.state.value.kind).toBe('loading')
  expect(m.api.notice.value.text).toMatch(/reading/i)
  await settle(); release(body()); await settle()
  expect(m.api.state.value.kind).toBe('collected')
  expect(m.api.sections.value.map(s => s.label)).toEqual(['Indexing', 'Integrity', 'Structured data', 'Link graph', 'Duplicates', 'Resources'])
})
it('flag off: renders the held state and makes no request', async () => {
  const fetch = vi.fn()
  const m = mount({ rolloutEvidenceFamilies: false }, fetch); await settle()
  expect(m.api.state.value.kind).toBe('flag_off'); expect(fetch).not.toHaveBeenCalled(); expect(m.api.sections.value).toEqual([])
})
it('a v1 audit renders not collected with no sections', async () => {
  const m = mount({ rolloutEvidenceFamilies: true }, async () => body(d1, { wire_contract_version: 's14-wire-1', evidence_families: null, reason: 'not_collected' })); await settle()
  expect(m.api.state.value.kind).toBe('not_collected'); expect(m.api.sections.value).toEqual([])
})
it('malformed data is refused with a message and no sections', async () => {
  const m = mount({ rolloutEvidenceFamilies: true }, async () => body(d1, { evidence_families: { ...families(), version: 9 } })); await settle()
  expect(m.api.state.value.kind).toBe('invalid'); expect(m.api.notice.value.tone).toBe('error'); expect(m.api.notice.value.text).toMatch(/version/); expect(m.api.sections.value).toEqual([])
})
it('a failed read is an error that can be retried, not an empty result', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(body())
  const m = mount({ rolloutEvidenceFamilies: true }, fetch); await settle()
  expect(m.api.state.value.kind).toBe('unavailable')
  await m.api.load(); await settle()
  expect(m.api.state.value.kind).toBe('collected')
})
it('a late response for a previous audit is ignored', async () => {
  const resolvers: Array<(v: unknown) => void> = []
  const m = mount({ rolloutEvidenceFamilies: true }, () => new Promise(r => resolvers.push(r))); await settle()
  m.props.deliveryId = d2; await settle()
  resolvers[1]!(body(d2)); await settle()
  resolvers[0]!(body(d1)); await settle()
  expect(m.api.state.value.kind).toBe('collected')
  expect((m.api.state.value as any).families.families.s02_indexing).toBeTruthy()
  expect(resolvers).toHaveLength(2)
})
it('the template renders each family, the notice, the truncation line and local-time-free content', () => {
  expect(vue).toMatch(/v-for="section in sections"/)
  expect(vue).toMatch(/notice\.text/)
  expect(vue).toMatch(/section\.truncation/)
  expect(vue).toMatch(/section\.unknownReasons/)
  expect(vue).toMatch(/aria-busy/)
  expect(vue).toMatch(/role="alert"/)
  expect(vue).toMatch(/table-scroll/)
})

it('SeosmithDashboard mounts the panel for the selected audit', () => {
  const dash = read('../app/components/SeosmithDashboard.vue')
  expect(dash).toMatch(/<EvidenceFamilies[^>]*:website-id="ws\.selectedId\.value"[^>]*:delivery-id="selected\.delivery_id"/)
})
it('nuxt.config declares the flag off by default, in public runtime config', () => {
  const cfg = read('../nuxt.config.ts')
  expect(cfg).toMatch(/public:\s*{[\s\S]*rolloutEvidenceFamilies: false[\s\S]*?}\s*,\s*}\s*,\s*app:/)
})

// ---- Template rendering: the real <template> of EvidenceFamilies.vue, server-rendered to HTML ----
const renderFn = (Vue as any).compile(parse(vue).descriptor.template!.content)
async function html(runtime: Record<string, unknown>, fetch: (u: string, o: any) => Promise<unknown>) {
  const m = mount(runtime, fetch); await settle()
  const app = Vue.createSSRApp({ setup: () => m.api, render: renderFn })
  return renderToString(app)
}
const text = (h: string) => h.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const withFamily = (key: string, s: Record<string, unknown>) => { const f = families(); (f.families as any)[key] = { ...sec(key), ...s }; return body(d1, { evidence_families: f }) }
const cov = (o: Record<string, unknown> = {}) => ({ entities: 2, eligible: 2, attempted: 2, observed: 2, unknown: 0, unknown_reasons: {}, ...o })
const itm = (o: Record<string, unknown> = {}) => ({ entity_id: 'sha256:aa', locator: '/pages/1', kind: 'noindex', outcome: 'issue', reason: null, facts: { a: 1 }, ...o })
const on = { rolloutEvidenceFamilies: true }

it('renders loading with aria-busy and no sections', async () => {
  const h = await html(on, () => new Promise(() => {}))
  expect(h).toContain('aria-busy="true"'); expect(text(h)).toContain('Reading stored evidence families'); expect(h).not.toContain('evidence-family"')
})
it('renders the held state and no request', async () => {
  const fetch = vi.fn(); const h = await html({ rolloutEvidenceFamilies: false }, fetch)
  expect(text(h)).toContain('not available yet'); expect(fetch).not.toHaveBeenCalled(); expect(h).not.toContain('<table')
})
it('renders not collected for a v1 audit, saying it is not a pass', async () => {
  const h = await html(on, async () => body(d1, { wire_contract_version: 's14-wire-1', evidence_families: null, reason: 'not_collected' }))
  expect(text(h)).toMatch(/not collected/); expect(text(h)).toMatch(/does not mean the checks passed/); expect(h).not.toContain('<table')
})
it('renders not found (404)', async () => {
  expect(text(await html(on, async () => { throw { statusCode: 404 } }))).toContain('not found for your account')
})
it('renders an upstream 503 as an alert with Try again, not as held', async () => {
  const h = await html(on, async () => { throw { statusCode: 503, data: { error: 'Websites are temporarily unavailable. Please try again.' } } })
  expect(h).toContain('role="alert"'); expect(h).toContain('Try again'); expect(text(h)).not.toContain('not available yet')
})
it('renders the API held 503 as held, with no Try again', async () => {
  const h = await html(on, async () => { throw { statusCode: 503, data: { error: 'This feature is not available yet.' } } })
  expect(text(h)).toContain('not available yet'); expect(h).not.toContain('Try again')
})
it('renders a network failure as an alert with Try again', async () => {
  const h = await html(on, async () => { throw new Error('net') })
  expect(h).toContain('role="alert"'); expect(h).toContain('Try again'); expect(text(h)).toMatch(/not an empty result/)
})
it('renders an invalid body as an alert naming the problem and showing no sections', async () => {
  const h = await html(on, async () => body(d1, { evidence_families: { ...families(), version: 9 } }))
  expect(h).toContain('role="alert"'); expect(text(h)).toMatch(/refused.*version/); expect(h).not.toContain('<table'); expect(h).not.toContain('evidence-family"')
})
it('renders six complete sections with counts as label/value pairs inside one wrapper each', async () => {
  const h = await html(on, async () => body())
  expect((h.match(/<h4>/g) ?? [])).toHaveLength(6)
  expect(text(h)).toContain('Complete')
  expect((h.match(/class="evidence-family-count"/g) ?? [])).toHaveLength(30)
  expect(h).toMatch(/<div class="evidence-family-count"><dt>Entities<\/dt><dd>2<\/dd><\/div>/)
  expect(text(h)).toContain('No items were recorded for this family.')
})
it('renders a partial section with its unknown count, reasons and an Unknown row', async () => {
  const h = await html(on, async () => withFamily('s02_indexing', { state: 'partial', coverage: cov({ unknown: 1, unknown_reasons: { robots_unavailable: 1 } }), items: [itm({ outcome: 'unknown', reason: 'robots_unavailable' })], items_total: 1 }))
  const t = text(h)
  expect(t).toContain('Partial'); expect(t).toMatch(/1 entity could not be determined/); expect(t).toContain('Unknown for 1: robots.txt could not be read')
  expect(t).toMatch(/\/pages\/1 noindex Unknown Robots\.txt could not be read/)
})
it('renders an unavailable section with no counts and no zero', async () => {
  const h = await html(on, async () => withFamily('s05_link_graph', { state: 'unavailable', reason: 'analyzer_error' }))
  const t = text(h)
  expect(t).toContain('Unavailable'); expect(t).toMatch(/Not collected for this audit: the analyzer failed/); expect(t).toContain('different from zero')
  // five other sections still show counts, so exactly 25 count wrappers
  expect((h.match(/class="evidence-family-count"/g) ?? [])).toHaveLength(25)
})
it('renders a truncated section with the shown/total line and the omission reason', async () => {
  const h = await html(on, async () => withFamily('s03_integrity', { state: 'partial', coverage: cov({ unknown: 1, unknown_reasons: { family_item_limit: 1 } }), items: [itm()], items_total: 5, omitted_items: 4, truncated: true, omitted_reason: 'family_item_limit' }))
  expect(text(h)).toContain('Showing 1 of 5 items; 4 omitted because the per-family item limit was reached.')
})
it('a fully truncated section (no items kept) does not also claim no items were recorded', async () => {
  const f = withFamily('s03_integrity', { state: 'partial', coverage: cov({ unknown: 1, unknown_reasons: { report_byte_budget: 1 } }), items: [], items_total: 3, omitted_items: 3, truncated: true, omitted_reason: 'report_byte_budget' })
  const h = await html(on, async () => f)
  expect(text(h)).toContain('Showing 0 of 3 items; 3 omitted')
  // five other sections have no items and say so; the truncated one must not
  expect((text(h).match(/No items were recorded for this family\./g) ?? [])).toHaveLength(5)
})
it('renders the report-budget banner', async () => {
  const f = families() as any; f.budget_state = 'report_byte_budget'
  const h = await html(on, async () => body(d1, { evidence_families: f }))
  expect(h).toContain('role="status"'); expect(text(h)).toMatch(/size budget/); expect(text(h)).toContain('Coverage counts are complete')
})
it('renders an item with a prototype-named reason as text, not function source', async () => {
  const h = await html(on, async () => withFamily('s02_indexing', { state: 'partial', coverage: cov({ unknown: 1, unknown_reasons: { constructor: 1 } }), items: [itm({ outcome: 'unknown', reason: 'constructor' })], items_total: 1 }))
  expect(h).not.toMatch(/native code|\[object/); expect(text(h)).toContain('Constructor')
})
