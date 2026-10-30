import type { GoogleReport } from '../types/dashboard'
export function metric(report: GoogleReport | undefined, name: string, row = 0): number {
  const index = report?.metricHeaders?.findIndex(h => h.name === name) ?? -1
  if (index < 0) return 0
  const value = Number(report?.rows?.[row]?.metricValues?.[index]?.value ?? 0)
  return Number.isFinite(value) ? value : 0
}
export function validDateRange(start: string, end: string) {
  if (![start, end].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value)) return false
  const days = (Date.parse(end) - Date.parse(start)) / 86400_000
  return days >= 0 && days < 366
}
export function dateLabel(value: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value + 'T12:00:00Z'))
}
