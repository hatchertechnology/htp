import { expect, it } from 'vitest'
import { sampledUrl, performanceSource, vitalValue } from '../shared/utils/page-performance'
it('keeps page and origin source identities separate for each device', () => {
  expect(performanceSource('PHONE', '')).toBe('PHONE')
  expect(performanceSource('PHONE', 'https://example.com/')).toBe('PHONE|https://example.com/')
  expect(sampledUrl('/services?area=macon', 'example.com')).toBe('https://example.com/services?area=macon')
  expect(sampledUrl('https://EXAMPLE.com:443/services', 'example.com')).toBe('https://example.com/services')
})
it('rejects cross-host, insecure and credential-bearing samples', () => {
  for (const input of ['https://other.example/a', '//other.example/a', 'http://example.com/a', 'https://user@example.com/a', 'https://example.com:8443/a', '/a#fragment', '/a#', '/a|b', '/a\\b']) expect(sampledUrl(input, 'example.com')).toBeNull()
})
it('retains missing, malformed and real zero metrics distinctly', () => {
  for (const value of [null, undefined, '', 'not a number', -1, Infinity, true, ' ', [], {}]) expect(vitalValue(value)).toBeNull()
  expect(vitalValue('0')).toBe(0)
  expect(vitalValue('0.03')).toBe(0.03)
})
