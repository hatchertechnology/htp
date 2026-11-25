import { expect, it } from 'vitest'
import { safeReturnPath } from '../shared/utils/return-path'

it('accepts same-origin absolute paths with query and hash', () => {
  for (const value of ['/', '/websites', '/websites?x=1#y', '/oauth/consent?authorization_id=abc', '/forms/confirm#r:t', '/a/b/c/']) {
    expect(safeReturnPath(value)).toBe(value)
  }
  expect(safeReturnPath(['/websites', '/other'])).toBe('/websites')
})

it('rejects another origin, scheme or protocol-relative value', () => {
  for (const value of ['//evil.test', '/\\evil.test', 'https://evil.test', 'http://evil.test/x', 'javascript:alert(1)', '\\evil', 'evil.test', '', ' /x', ' /x\n', '/x\ny']) {
    expect(safeReturnPath(value), value).toBeNull()
  }
})

it('rejects CR/LF and control characters, including encoded ones', () => {
  for (const value of ['/%0d%0aLocation:', '/x%0a', '/x%00', '/%2F%2Fevil.test', '/x\u007f']) {
    expect(safeReturnPath(value), value).toBeNull()
  }
})

it('rejects the sign-in page (with one trailing slash, query or hash) to avoid a loop', () => {
  for (const value of ['/sign-in', '/sign-in/', '/sign-in?redirect=/', '/sign-in/?x=1', '/sign-in#top']) {
    expect(safeReturnPath(value), value).toBeNull()
  }
})

it('rejects non-strings, oversized values and unparsable input without throwing', () => {
  for (const value of [null, undefined, 7, true, {}, [], ['//evil.test']]) {
    expect(safeReturnPath(value)).toBeNull()
  }
  expect(safeReturnPath(`/${'a'.repeat(2048)}`)).toBeNull()
  const throwing = { toString() { throw new Error('boom') } }
  expect(() => safeReturnPath(throwing)).not.toThrow()
  expect(safeReturnPath(throwing)).toBeNull()
})
