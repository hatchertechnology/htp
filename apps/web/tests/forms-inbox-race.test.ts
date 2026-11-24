import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import * as response from '../shared/utils/forms-response-client'
import * as inbox from '../shared/utils/forms-inbox-client'
import * as owner from '../shared/utils/forms-owner-client'
const id = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const a = { id: id(2) }, b = { id: id(3) }, row = { id: id(4), status: 'new' }
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function fixture() {
  const reads: ((value: unknown) => void)[] = []
  const fetch = vi.fn((_url: string, options: any) => options.method
    ? Promise.resolve({ id: row.id, status: 'reviewed' })
    : new Promise(resolve => reads.push(resolve)))
  const source = readFileSync(new URL('../app/components/WebsiteForms.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1]!.split('</script>')[0]!
  const script = ts.transpileModule(`${source}\neligible.value=true; globalThis.demo={inbox,manageResponse,submissions,moreResponses,responseUnresolved,error};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const context: Record<string, any> = {
    exports: {}, require: () => ({ ...response, ...inbox, ...owner }),
    defineProps: () => ({ websiteId: id(1), fqdn: 'example.test', mode: 'pilot' }),
    useNuxtApp: () => ({ $supabase: {} }),
    useRuntimeConfig: () => ({ public: { staticDashboard: true, rolloutFormsPilot: true, rolloutFormsResponses: true, apiBaseUrl: 'https://api.example.test' } }),
    useAuth: () => ({ user: { value: { id: 'owner' } }, accessToken: async () => 'synthetic-token' }),
    ref: (value: unknown) => ({ value }), computed: (fn: () => unknown) => ({ get value() { return fn() } }), watch: () => {}, $fetch: fetch,
  }
  runInNewContext(script, context)
  return { ...context.demo, reads, fetch }
}
const page = (items: unknown[], has_more = false) => ({ items, has_more })
// Execute the actual component at synthetic Nuxt/Vue boundaries, with no hosted I/O.
it.each([false, true])('discards deferred ABA and pagination snapshots after reconciliation (unknown=%s)', async unknown => {
  const f = fixture()
  const old = f.inbox(a); await tick()
  const middle = f.inbox(b); await tick()
  const fresh = f.inbox(a); await tick()
  f.reads[2](page([row])); await fresh
  const more = f.inbox(a, true); await tick()
  if (unknown) f.fetch.mockImplementationOnce(() => Promise.reject(new Error('transport lost')))
  const write = f.manageResponse(row, 'reviewed'); await tick()
  expect(f.reads).toHaveLength(5)
  f.reads[4](page([{ ...row, status: 'reviewed' }])); await write
  f.reads[0](page([row], true)); await old
  f.reads[1](page([{ ...row, id: id(5) }], true)); await middle
  f.reads[3](page([row], true)); await more
  expect(f.submissions.value).toEqual([{ ...row, status: 'reviewed' }])
  expect(f.moreResponses.value).toBe(false)
  expect(f.responseUnresolved.value).toBe(unknown)
  const writes = f.fetch.mock.calls.filter(([, options]) => options.method)
  expect(writes).toHaveLength(1)
  expect(writes[0]![1]).toMatchObject({ retry: 0, redirect: 'error' })
  if (unknown) expect(f.error.value).toContain('outcome is unknown')
})
it('accepts only the latest concurrent pagination response', async () => {
  const f = fixture()
  const first = f.inbox(a); await tick(); f.reads[0](page([row], true)); await first
  const old = f.inbox(a, true); await tick()
  const latest = f.inbox(a, true); await tick()
  f.reads[2](page([{ ...row, id: id(5) }])); await latest
  f.reads[1](page([row], true)); await old
  expect(f.submissions.value.map((item: any) => item.id)).toEqual([row.id, id(5)])
  expect(f.moreResponses.value).toBe(false)
})
