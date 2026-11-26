// Exercises the real EvidenceFamilies.vue script (no browser): every state the
// panel can be in, stale-response handling, and the template's wiring.
import { readFileSync } from 'node:fs'
import { transpile } from 'typescript'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { expect, it, vi } from 'vitest'
import * as lib from '../shared/utils/wire2-families'
import * as client from '../shared/utils/wire2-families-client'

const site = '00000000-0000-0000-0000-000000000001', d1 = '00000000-0000-0000-0000-000000000002', d2 = '00000000-0000-0000-0000-000000000003'
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const vue = read('../app/components/EvidenceFamilies.vue')
const script = vue.split('<script setup lang="ts">')[1]!.split('</script>')[0]!.replace(/^import .*$/gm, '')
const make = new Function('deps', `const {ref,computed,watch,onBeforeUnmount,defineProps,useRuntimeConfig,useAuth,$fetch,lib,client}=deps\nconst {FAMILY_KEYS,panelNotice,sectionView}=lib\nconst {loadEvidenceFamilies}=client\n${transpile(script, { target: 99 })}\nreturn { state, notice, sections, load, generation: () => generation }`)
const sec = () => ({ section_version: 1, semantics: 's', state: 'complete', reason: null, coverage: { entities: 2, eligible: 2, attempted: 2, observed: 2, unknown: 0, unknown_reasons: {} }, summary: {}, items: [], items_total: 0, omitted_items: 0, omitted_reason: null, truncated: false, max_items: 256, max_bytes: 131072 })
const families = () => ({ version: 1, semantics: 's14-families-1', max_bytes: 786432, budget_state: 'within_budget', families: Object.fromEntries(lib.FAMILY_KEYS.map(k => [k, sec()])) })
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
