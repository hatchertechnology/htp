import type { BingRow } from '../types/bing'
// Microsoft JSON dates encode an instant plus the provider's local UTC offset.
// Preserve Bing's calendar day instead of shifting it into the viewer's timezone.
export function bingDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value)
  if (match) {
    const offset = match[2]
    const minutes = offset ? (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3))) * (offset[0] === '-' ? -1 : 1) : 0
    const time = Number(match[1]) + minutes * 60_000
    if (!Number.isFinite(time) || Math.abs(time) > 8.64e15) return null
    return new Date(time).toISOString().slice(0, 10)
  }
  const date = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date ? date : null
}
export function bingNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
export function bingTraffic(rows: BingRow[] | null | undefined, start: string, end: string) {
  const daily = new Map<string, { date: string; clicks: number; impressions: number }>()
  for (const row of rows ?? []) {
    const date = bingDate(row.Date), clicks = bingNumber(row.Clicks), impressions = bingNumber(row.Impressions)
    if (date && date >= start && date <= end && clicks !== null && impressions !== null) daily.set(date, { date, clicks, impressions })
  }
  return [...daily.values()].sort((a, b) => a.date.localeCompare(b.date))
}
// Documented Bing CrawlIssues flags; preserve unknown bits for future versions.
export function bingIssue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'Not reported'
  if (value === 0) return 'None reported'
  const flags: [number, string][] = [
    [1, '301 redirect'], [2, '302 redirect'], [4, 'HTTP client error'], [8, 'HTTP server error'],
    [16, 'Blocked by robots.txt'], [32, 'Malware detected'], [64, 'Important URL blocked by robots.txt'],
    [128, 'DNS error'], [256, 'Request timed out'],
  ]
  const labels = flags.filter(([flag]) => Math.floor(value / flag) % 2 === 1).map(([, label]) => label)
  const unknown = value - value % 512
  if (unknown) labels.push(`Issue code ${unknown}`)
  return labels.join(', ')
}
