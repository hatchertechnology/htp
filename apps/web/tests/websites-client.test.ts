import { describe, expect, it } from 'vitest'
import { resolveWebsitePath, websiteApiOrigin } from '../shared/utils/websites-client'

const base = 'https://api.example.test'

describe('default (staticDashboard off) keeps the same-origin proxy', () => {
  it.each([
    '/api/websites?limit=50&offset=0',
    '/api/websites',
    '/api/websites/00000000-0000-0000-0000-000000000001',
  ])('leaves %s unchanged even with no API base configured', path => {
    expect(resolveWebsitePath(path, false, undefined)).toBe(path)
    expect(resolveWebsitePath(path, false, base)).toBe(path)
  })
})

describe('static mode calls the API origin directly', () => {
  it('maps list, detail and query strings onto the API /websites routes', () => {
    expect(resolveWebsitePath('/api/websites?limit=50&offset=50', true, `${base}/`)).toBe(`${base}/websites?limit=50&offset=50`)
    expect(resolveWebsitePath('/api/websites/00000000-0000-0000-0000-000000000001', true, base)).toBe(`${base}/websites/00000000-0000-0000-0000-000000000001`)
  })
  it('refuses paths outside the websites collection', () => {
    for (const path of ['/api/forms/x', '/api/websites/../secrets', '//evil.example/websites', '/api/websitesx']) {
      expect(() => resolveWebsitePath(path, true, base)).toThrow(/Unsupported website request path/)
    }
  })
  it('requires a configured API base', () => {
    expect(() => resolveWebsitePath('/api/websites', true, undefined)).toThrow(/needs an API base URL/)
    expect(() => resolveWebsitePath('/api/websites', true, '  ')).toThrow(/needs an API base URL/)
  })
})

describe('API base validation', () => {
  it.each([
    ['https://api.example.test/', 'https://api.example.test'],
    ['https://api.example.test:8443', 'https://api.example.test:8443'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
  ])('accepts %s', (input, origin) => {
    expect(websiteApiOrigin(input)).toBe(origin)
  })
  it.each([
    'http://api.example.test',
    'ftp://api.example.test',
    'https://user:pass@api.example.test',
    'https://api.example.test/v1',
    'https://api.example.test/?x=1',
    'https://api.example.test/#frag',
    'not a url',
  ])('rejects %s', input => {
    expect(() => websiteApiOrigin(input)).toThrow()
  })
})
