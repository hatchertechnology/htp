import type { BusinessPerformance, GoogleDate } from '../types/insights'
export function googleDay(date: GoogleDate) { return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}` }
// Google may omit values for dates or return no series. Preserve missing data
// separately from an explicitly reported zero; never manufacture totals.
export function businessDays(data: BusinessPerformance | null | undefined) {
  const days: Record<string, Record<string, number>> = {}
  for (const group of data?.multiDailyMetricTimeSeries ?? []) for (const series of group.dailyMetricTimeSeries ?? []) {
    for (const entry of series.timeSeries?.datedValues ?? []) {
      if (entry.value === undefined) continue
      const day = googleDay(entry.date)
      const value = Number(entry.value)
      if (Number.isFinite(value)) (days[day] ??= {})[series.dailyMetric] = value
    }
  }
  return days
}
export function businessTotal(days: Record<string, Record<string, number>>, key: string): number | null {
  const values = Object.values(days).map(day => day[key]).filter((value): value is number => value !== undefined)
  return values.length ? values.reduce((a, b) => a + b, 0) : null
}
export function displayJson(value: unknown) {
  return value === null || value === undefined ? '(not set)' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}
