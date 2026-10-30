import { describe, expect, it } from 'vitest'
import { seal, unseal } from '../server/utils/sealed-cookie'
import { metric, validDateRange } from '../shared/utils/analytics'

const secret = Buffer.alloc(32, 7).toString('base64')
describe('Google connection cookies', () => {
  it('encrypts credentials, rejects tampering and isolates cookie purposes', () => {
    const source = { refresh: 'private-refresh-token', user: 'owner' }
    const value = seal(source, secret, 'grant')
    expect(value).not.toContain(source.refresh)
    expect(unseal(value, secret, 'grant')).toEqual(source)
    expect(unseal(value, secret, 'state')).toBeNull()
    const changed = Buffer.from(value, 'base64url'); changed[30] = changed[30]! ^ 1
    expect(unseal(changed.toString('base64url'), secret, 'grant')).toBeNull()
    expect(unseal(value, Buffer.alloc(32, 8).toString('base64'), 'grant')).toBeNull()
  })
  it('rejects missing and overlong cookies', () => {
    expect(unseal(undefined, secret, 'grant')).toBeNull()
    expect(unseal('x'.repeat(9000), secret, 'grant')).toBeNull()
  })
})
describe('Analytics display', () => {
  it('reads aggregate values by header name, not by summing daily users', () => {
    const report = { metricHeaders: [{ name: 'sessions' }, { name: 'activeUsers' }], rows: [{ metricValues: [{ value: '20' }, { value: '8' }] }] }
    expect(metric(report, 'activeUsers')).toBe(8)
    expect(metric(report, 'sessions')).toBe(20)
    expect(metric(report, 'missing')).toBe(0)
    expect(metric({ metricHeaders: [{ name: 'sessions' }], rows: [{ metricValues: [{ value: 'NaN' }] }] }, 'sessions')).toBe(0)
  })
  it('accepts real ordered dates and caps the range', () => {
    expect(validDateRange('2026-10-01', '2026-10-27')).toBe(true)
    expect(validDateRange('2026-02-30', '2026-10-27')).toBe(false)
    expect(validDateRange('2026-99-99', '2026-10-27')).toBe(false)
    expect(validDateRange('2026-10-27', '2026-10-01')).toBe(false)
    expect(validDateRange('2025-01-01', '2026-10-27')).toBe(false)
  })
})
