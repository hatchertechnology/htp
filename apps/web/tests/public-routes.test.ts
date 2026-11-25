import { expect, it } from 'vitest'
import { SIGN_IN_PATH, isPublicRoute, isSignInPath } from '../shared/utils/public-routes'

it('publishes the sign-in page, provider callbacks, consent and confirmation only', () => {
  expect(SIGN_IN_PATH).toBe('/sign-in')
  for (const path of ['/sign-in', '/oauth/consent', '/forms/confirm', '/auth/google/callback', '/auth/bing/callback']) {
    expect(isPublicRoute(path), path).toBe(true)
  }
})

it('normalises the way vue-router matches: one or more trailing slashes, case and percent-encoding', () => {
  for (const path of ['/sign-in/', '/sign-in//', '/oauth/consent/', '/forms/confirm/', '/forms/confirm/?x=1', '/SIGN-IN', '/OAuth/Consent', '/%73ign-in', '/auth/Google/Callback']) {
    expect(isPublicRoute(path), path).toBe(true)
  }
})

it('keeps every workspace and developer page protected', () => {
  for (const path of ['/', '/websites', '/websites/', '/forms', '/connections', '/independent-audits', '/guide', '/developer', '/mcp', '/settings', '/unknown']) {
    expect(isPublicRoute(path), path).toBe(false)
  }
})

it('matches exact paths, never prefixes', () => {
  for (const path of ['/forms/confirmx', '/forms/confirm/extra', '/oauth/consent/extra', '/auth/other', '/auth/google/callback/x', '/auth/google', '/sign-in-now', 'sign-in', '', '//sign-in']) {
    expect(isPublicRoute(path), path).toBe(false)
  }
})

it('recognises every spelling of the sign-in route, so it can never be a redirect loop', () => {
  for (const path of ['/sign-in', '/sign-in/', '/sign-in//', '/sign-in/?x=1', '/sign-in#top', '/SIGN-IN', '/%73ign-in', '/Sign-In']) {
    expect(isSignInPath(path), path).toBe(true)
  }
  for (const path of ['/', '/websites', '/sign-in-now', '//sign-in', 'sign-in', '']) {
    expect(isSignInPath(path), path).toBe(false)
  }
})
