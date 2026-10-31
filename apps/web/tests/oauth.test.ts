import { describe, expect, it } from 'vitest'
import { authorizationId, consentRedirect, scopeDescription } from '../shared/utils/oauth'

describe('OAuth consent URL handling', () => {
  it('accepts only bounded opaque IDs, not redirect parameters or duplicate query values', () => {
    expect(authorizationId('a0b1c2d3-1234-1234-1234-abcdef123456')).toBeTruthy()
    for (const input of [undefined, '', ['first', 'second'], 'a/b', 'https://evil.example', 'a'.repeat(201)]) expect(authorizationId(input)).toBeNull()
  })
  it('permits validated HTTPS and local agent callbacks while rejecting active URL schemes', () => {
    for (const value of ['https://agent.example/callback?code=abc&state=xyz', 'http://127.0.0.1:54321/callback', 'http://localhost:1234/callback', 'http://[::1]:3456/callback']) expect(consentRedirect(value)).toBe(value)
    for (const value of ['javascript:alert(1)', 'data:text/html,hello', '//evil.example', '/oauth/callback', 'http://remote.example/callback', 'https://user:password@agent.example/callback']) expect(() => consentRedirect(value)).toThrow()
  })
  it('labels identity scopes separately from website permissions', () => {
    expect(scopeDescription('openid')).toBe('Identify your HTP account')
    expect(scopeDescription('email')).toBe('Read your email address')
    expect(scopeDescription('future_scope')).toBe('future_scope')
  })
})
