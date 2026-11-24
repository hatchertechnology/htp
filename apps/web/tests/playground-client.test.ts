import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { playgroundTarget } from '../shared/utils/playground-client'

// Execute the actual component script with synthetic Nuxt/Vue boundaries: no browser or hosted I/O.
function explorer(staticDashboard: boolean, raw: ReturnType<typeof vi.fn>) {
  const source = readFileSync(new URL('../app/components/ApiExplorer.vue', import.meta.url), 'utf8').split('<script setup lang="ts">')[1]!.split('</script>')[0]!
  const script = ts.transpileModule(`${source}\nglobalThis.demo = { sendRequest, clear, response, error, loading, access, operation };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const context: Record<string, any> = {
    exports: {}, require: () => ({ playgroundTarget }),
    defineProps: () => ({ transport: 'mcp' }),
    useRuntimeConfig: () => ({ public: { staticDashboard, apiBaseUrl: 'https://api.example' } }),
    useAuth: () => ({ user: { value: { id: 'fixture-user' } }, accessToken: async () => 'synthetic-token' }),
    ref: (value: unknown) => ({ value }), computed: (fn: () => unknown) => ({ get value() { return fn() } }),
    watch: () => {}, onBeforeUnmount: () => {}, onMounted: () => {},
    AbortController, performance, $fetch: { raw },
  }
  runInNewContext(script, context)
  return context.demo
}
const reply = (body: unknown, status = 200) => ({ status, statusText: status === 200 ? 'OK' : 'Unauthorized', ok: status === 200, headers: new Headers({ 'content-type': 'application/json' }), _data: body })

describe('ApiExplorer synthetic request lifecycle', () => {
  it('presents static status/content/body and sends only a fixed demo with no retries or cookies', async () => {
    const raw = vi.fn().mockResolvedValue(reply({ error: 'unauthorized' }, 401))
    const demo = explorer(true, raw)
    demo.access.value = 'secured'
    await demo.sendRequest()
    expect(raw.mock.calls[0]![0]).toBe('https://api.example/playground/secured')
    expect(raw.mock.calls[0]![1]).toMatchObject({ body: { transport: 'mcp', operation: 'call' }, headers: { Authorization: 'Bearer synthetic-token' }, retry: 0, redirect: 'error', credentials: 'omit', ignoreResponseError: true })
    expect(demo.response.value).toMatchObject({ status: 401, statusText: 'Unauthorized', contentType: 'application/json', body: { error: 'unauthorized' } })
  })
  it('aborts and discards stale responses when cleared', async () => {
    let resolve!: (result: unknown) => void
    const raw = vi.fn(() => new Promise(done => { resolve = done }))
    const demo = explorer(true, raw)
    const pending = demo.sendRequest()
    await Promise.resolve()
    await Promise.resolve()
    demo.clear()
    expect(raw.mock.calls[0]![1].signal.aborted).toBe(true)
    resolve(reply({ stale: true }))
    await pending
    expect(demo.response.value).toBeNull()
    expect(demo.loading.value).toBe(false)
    expect(raw).toHaveBeenCalledTimes(1)
  })
  it('retains the Nitro response envelope and same-origin request', async () => {
    const body = { status: 200, statusText: 'OK', contentType: 'application/json', durationMs: 12, body: { message: 'hello world' } }
    const raw = vi.fn().mockResolvedValue(reply(body))
    const demo = explorer(false, raw)
    await demo.sendRequest()
    expect(raw.mock.calls[0]![0]).toBe('/api/playground')
    expect(raw.mock.calls[0]![1]).toMatchObject({ body: { transport: 'mcp', access: 'public', operation: 'call' }, retry: 0 })
    expect(demo.response.value).toBe(body)
  })
})
