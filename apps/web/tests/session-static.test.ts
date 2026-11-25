import { afterEach, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ onAuthStateChange: vi.fn(), getSession: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: sdk }) }))

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

async function runPlugin(publicConfig: Record<string, unknown>, session: unknown) {
  const states = new Map<string, { value: unknown }>()
  const hooks = new Map<string, () => void>()
  sdk.getSession.mockResolvedValue({ data: { session }, error: null })
  vi.stubGlobal('defineNuxtPlugin', (factory: unknown) => factory)
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { supabaseUrl: 'https://test.supabase.co', supabasePublishableKey: 'public-test-key', ...publicConfig } }))
  vi.stubGlobal('useState', (key: string, initial: () => unknown) => {
    if (!states.has(key)) states.set(key, { value: initial() })
    return states.get(key)
  })
  const { default: plugin } = await import('../app/plugins/supabase.client')
  const factory = plugin as unknown as (app: unknown) => { provide: Record<string, unknown> }
  const result = factory({ hook: (name: string, callback: () => void) => hooks.set(name, callback) })
  return { states, hooks, result }
}

it('restores the static build session immediately, without waiting for app:mounted', async () => {
  const user = { id: 'static-user', email: 'qa@example.invalid' }
  const { states, hooks, result } = await runPlugin({ staticDashboard: true }, { access_token: 'token', user })

  // The first route middleware runs before app:mounted, so the restore has started.
  expect(sdk.getSession).toHaveBeenCalledOnce()
  expect(sdk.onAuthStateChange).toHaveBeenCalledOnce()
  expect(hooks.has('app:mounted')).toBe(false)

  await expect(result.provide.authSession).resolves.toEqual(user)
  expect(states.get('auth:ready')?.value).toBe(true)
  expect(states.get('auth:user')?.value).toEqual(user)

  const onChange = sdk.onAuthStateChange.mock.calls[0]![0] as (event: string, session: unknown) => void
  onChange('SIGNED_IN', { user })
  expect(states.get('auth:user')?.value).toEqual(user)
  onChange('SIGNED_OUT', null)
  expect(states.get('auth:user')?.value).toBeNull()
  expect(states.get('auth:ready')?.value).toBe(true)
})

it('settles the static resolver with null when no session is stored', async () => {
  const { states, result } = await runPlugin({ staticDashboard: true }, null)
  await expect(result.provide.authSession).resolves.toBeNull()
  expect(states.get('auth:ready')?.value).toBe(true)
  expect(states.get('auth:user')?.value).toBeNull()
})

it('keeps the SSR build deferred until app:mounted and resolves the middleware promise there', async () => {
  const user = { id: 'ssr-user', email: 'qa@example.invalid' }
  const { states, hooks, result } = await runPlugin({}, { access_token: 'token', user })

  expect(sdk.getSession).not.toHaveBeenCalled()
  expect(sdk.onAuthStateChange).not.toHaveBeenCalled()
  expect(states.get('auth:ready')?.value).toBe(false)

  hooks.get('app:mounted')!()
  await vi.waitFor(() => expect(states.get('auth:ready')?.value).toBe(true))
  await expect(result.provide.authSession).resolves.toEqual(user)
  expect(states.get('auth:user')?.value).toEqual(user)
})
