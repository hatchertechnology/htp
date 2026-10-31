import { expect, it } from 'vitest'
import { bingDate, bingNumber, bingTraffic, bingIssue } from '../shared/utils/bing'
it('preserves Microsoft JSON local provider days and handles invalid dates', () => {
  expect(bingDate('/Date(1316156400000-0700)/')).toBe('2011-09-16')
  expect(bingDate(`/Date(${Date.parse('2026-10-30T20:00:00Z')}+0800)/`)).toBe('2026-10-31')
  expect(bingDate('2026-10-30T00:00:00-07:00')).toBe('2026-10-30')
  for (const bad of [null,'bad','2026-02-30','/Date(999999999999999999999999999)/']) expect(bingDate(bad)).toBeNull()
})
it('filters daily traffic without inventing missing days or summing duplicate observations', () => {
  const rows = [
    { Date: '2026-10-01', Clicks: 1, Impressions: 10 },
    { Date: '2026-10-03', Clicks: 3, Impressions: 30 },
    { Date: '2026-10-01', Clicks: 2, Impressions: 20 },
    { Date: '2026-10-02', Clicks: null, Impressions: 100 },
    { Date: '2026-09-30', Clicks: 99, Impressions: 999 },
  ]
  expect(bingTraffic(rows, '2026-10-01', '2026-10-03')).toEqual([{ date:'2026-10-01',clicks:2,impressions:20 },{ date:'2026-10-03',clicks:3,impressions:30 }])
  for (const value of [null,undefined,Infinity,NaN,-1,'20']) expect(bingNumber(value)).toBeNull()
  expect(bingNumber(0)).toBe(0)
})

it('decodes documented crawl flags and retains unknown future flags', () => {
  expect(bingIssue(20)).toBe('HTTP client error, Blocked by robots.txt')
  expect(bingIssue(32)).toBe('Malware detected')
  expect(bingIssue(512 + 32)).toBe('Malware detected, Issue code 512')
  expect(bingIssue(null)).toBe('Not reported')
  expect(bingIssue(0)).toBe('None reported')
})
