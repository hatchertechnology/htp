import { expect, it } from 'vitest'
import { SIGN_IN_PATH, isPublicRoute } from '../shared/utils/public-routes'

it('publishes the sign-in page, provider callbacks, consent and confirmation only', () => {
  expect(SIGN_IN_PATH).toBe('/sign-in')
  for (const path of ['/sign-in', '/oauth/consent', '/forms/confirm', '/auth/google/callback', '/auth/bing/callback']) {
    expect(isPublicRoute(path), path).toBe(true)
  }
})

it('accepts exactly one trailing slash and ignores a query', () => {
  expect(isPublicRoute('/sign-in/')).toBe(true)
  expect(isPublicRoute('/oauth/consent/')).toBe(true)
  expect(isPublicRoute('/forms/confirm/?x=1')).toBe(true)
  expect(isPublicRoute('/sign-in//')).toBe(false)
})

it('keeps every workspace and developer page protected', () => {
  for (const path of ['/', '/websites', '/forms', '/connections', '/independent-audits', '/guide', '/developer', '/mcp', '/settings', '/unknown']) {
    expect(isPublicRoute(path), path).toBe(false)
  }
})

it('matches exact paths, never prefixes', () => {
  for (const path of ['/forms/confirmx', '/forms/confirm/extra', '/oauth/consent/extra', '/auth/other', '/auth/google/callback/x', '/auth/google', '/sign-in-now', 'sign-in', '']) {
    expect(isPublicRoute(path), path).toBe(false)
  }
})
