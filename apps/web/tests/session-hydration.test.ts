import { afterEach, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  onAuthStateChange: vi.fn(),
  getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: sdk }) }))

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('restores browser auth only after hydration, so disabled attributes match the server', async () => {
  const states = new Map<string, { value: unknown }>()
  const hooks = new Map<string, () => void>()
  vi.stubGlobal('defineNuxtPlugin', (factory: unknown) => factory)
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { supabaseUrl: 'https://test.supabase.co', supabasePublishableKey: 'public-test-key' } }))
  vi.stubGlobal('useState', (key: string, initial: () => unknown) => {
    if (!states.has(key)) states.set(key, { value: initial() })
    return states.get(key)
  })
  const { default: plugin } = await import('../app/plugins/supabase.client')
  const run = plugin as unknown as (app: { hook: (name: string, callback: () => void) => void }) => void
  run({ hook: (name, callback) => hooks.set(name, callback) })

  expect(states.get('auth:ready')?.value).toBe(false)
  expect(sdk.onAuthStateChange).not.toHaveBeenCalled()
  expect(sdk.getSession).not.toHaveBeenCalled()

  hooks.get('app:mounted')!()
  await Promise.resolve()
  expect(states.get('auth:ready')?.value).toBe(true)
  expect(sdk.getSession).toHaveBeenCalledOnce()
  const onChange = sdk.onAuthStateChange.mock.calls[0]![0]
  onChange('SIGNED_IN', { user: { id: 'test-user', email: 'qa@example.invalid' } })
  expect(states.get('auth:user')?.value).toEqual({ id: 'test-user', email: 'qa@example.invalid' })
  onChange('SIGNED_OUT', null)
  expect(states.get('auth:user')?.value).toBeNull()
})
