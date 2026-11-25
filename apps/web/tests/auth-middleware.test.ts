import { afterEach, beforeAll, expect, it, vi } from 'vitest'

type Navigation = { to: unknown; options?: unknown }
const control = {
  user: null as { id: string } | null,
  calls: 0,
  navigations: [] as Navigation[],
  app: { isHydrating: false, payload: { serverRendered: false } },
}
let middleware: (to: { path: string; fullPath: string; query: Record<string, unknown> }) => Promise<unknown>

beforeAll(async () => {
  vi.stubGlobal('defineNuxtRouteMiddleware', (fn: unknown) => fn)
  vi.stubGlobal('navigateTo', (to: unknown, options?: unknown) => { control.navigations.push({ to, options }); return { to, options } })
  vi.stubGlobal('useNuxtApp', () => control.app)
  vi.stubGlobal('useAuth', () => ({
    resolveSession: async () => { control.calls++; return control.user },
  }))
  const imported = await import('../app/middleware/auth.global')
  middleware = imported.default as unknown as typeof middleware
})

afterEach(() => {
  control.user = null; control.calls = 0; control.navigations = []
  control.app = { isHydrating: false, payload: { serverRendered: false } }
})

it('sends a signed-out visitor of a protected page to sign-in with the full return path', async () => {
  await middleware({ path: '/websites', fullPath: '/websites?tab=x', query: { tab: 'x' } })
  expect(control.navigations).toEqual([{ to: { path: '/sign-in', query: { redirect: '/websites?tab=x' } }, options: { replace: true } }])
})

it('treats a protected path with one trailing slash as protected', async () => {
  await middleware({ path: '/websites/', fullPath: '/websites/', query: {} })
  expect(control.navigations[0]).toEqual({ to: { path: '/sign-in', query: { redirect: '/websites/' } }, options: { replace: true } })
})

it('lets public routes through without awaiting the session', async () => {
  for (const path of ['/forms/confirm', '/oauth/consent', '/auth/google/callback', '/auth/bing/callback']) {
    await middleware({ path, fullPath: path, query: {} })
  }
  expect(control.calls).toBe(0)
  expect(control.navigations).toEqual([])
})

it('lets a signed-in visitor continue on a protected page', async () => {
  control.user = { id: 'owner' }
  expect(await middleware({ path: '/', fullPath: '/', query: {} })).toBeUndefined()
  expect(control.navigations).toEqual([])
})

it('returns a signed-in visitor from sign-in to a safe return path', async () => {
  control.user = { id: 'owner' }
  await middleware({ path: '/sign-in', fullPath: '/sign-in?redirect=%2Fwebsites%2F%3Ftab%3Dx', query: { redirect: '/websites/?tab=x' } })
  expect(control.navigations).toEqual([{ to: '/websites/?tab=x', options: { replace: true } }])
})

it('ignores an open-redirect attempt and falls back to the overview', async () => {
  control.user = { id: 'owner' }
  for (const redirect of ['//evil.test', 'https://evil.test', '/\\evil.test', 'javascript:alert(1)', '/sign-in', '/sign-in//', '/%73ign-in', '/SIGN-IN']) {
    control.navigations = []
    await middleware({ path: '/sign-in', fullPath: '/sign-in', query: { redirect } })
    expect(control.navigations).toEqual([{ to: '/', options: { replace: true } }])
  }
})

it('keeps a signed-out visitor on the sign-in page', async () => {
  expect(await middleware({ path: '/sign-in', fullPath: '/sign-in?redirect=%2F', query: { redirect: '/' } })).toBeUndefined()
  expect(control.navigations).toEqual([])
})

it('treats every sign-in spelling as the sign-in page, never as a protected 404', async () => {
  for (const path of ['/sign-in//', '/SIGN-IN', '/%73ign-in', '/Sign-In']) {
    control.navigations = []
    expect(await middleware({ path, fullPath: path, query: {} })).toBeUndefined()
    expect(control.navigations, path).toEqual([])
  }
  control.user = { id: 'owner' }
  for (const path of ['/sign-in//', '/SIGN-IN', '/%73ign-in', '/Sign-In']) {
    control.navigations = []
    await middleware({ path, fullPath: path, query: {} })
    expect(control.navigations, path).toEqual([{ to: '/', options: { replace: true } }])
  }
})

it('skips the hydration pass of the SSR build so app:mounted can restore the session', async () => {
  control.app = { isHydrating: true, payload: { serverRendered: true } }
  await middleware({ path: '/websites', fullPath: '/websites', query: {} })
  expect(control.calls).toBe(0)
  expect(control.navigations).toEqual([])
})
