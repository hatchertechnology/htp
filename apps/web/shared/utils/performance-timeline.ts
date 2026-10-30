import type { GoogleReport } from '../types/dashboard'
import type { SearchReport } from '../types/search'
import type { RepositoryBinding, RepositoryCommit } from '../types/repository'
import { validDateRange } from './analytics'
export type SearchMetric = 'clicks' | 'impressions' | 'ctr' | 'position'
export type OnsiteMetric = 'sessions' | 'activeUsers' | 'screenPageViews' | 'engagementRate'
export interface TimelineDay { date: string; time: number; search: number | null; onsite: number | null }
const DAY = 86400_000
function number(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
export function timelineDays(start: string, end: string, search: SearchReport | null, onsite: GoogleReport | undefined, searchMetric: SearchMetric, onsiteMetric: OnsiteMetric): TimelineDay[] {
  if (!validDateRange(start, end)) return []
  const searchValues = new Map((search?.daily.rows ?? []).map(row => [row.keys?.[0], searchMetric === 'position' && !row.impressions ? null : number(row[searchMetric])]))
  const index = onsite?.metricHeaders?.findIndex(header => header.name === onsiteMetric) ?? -1
  const onsiteValues = new Map((onsite?.rows ?? []).map(row => {
    const raw = row.dimensionValues?.[0]?.value ?? ''
    return [`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, index < 0 ? null : number(row.metricValues?.[index]?.value)]
  }))
  const result: TimelineDay[] = []
  for (let time = Date.parse(start); time <= Date.parse(end); time += DAY) {
    const date = new Date(time).toISOString().slice(0, 10)
    result.push({ date, time: time + DAY / 2, search: searchValues.get(date) ?? null, onsite: onsiteValues.get(date) ?? null })
  }
  return result
}
export function timelineCommits(commits: RepositoryCommit[], binding: RepositoryBinding | null | undefined, start: string, end: string): RepositoryCommit[] {
  if (!binding || !validDateRange(start, end)) return []
  const seen = new Set<string>()
  return commits.filter(commit => {
    const time = Date.parse(commit.committed_at)
    const key = `${commit.repository_url}:${commit.sha}`
    if (commit.repository_url !== binding.repository_url || commit.branch !== binding.branch || !Number.isFinite(time)
      || time < Date.parse(start) || time >= Date.parse(end) + DAY || seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.committed_at.localeCompare(b.committed_at) || a.sha.localeCompare(b.sha))
}
export function timelinePath(days: TimelineDay[], source: 'search' | 'onsite', x: (time: number) => number, y: (value: number) => number): string {
  let connected = false
  return days.map(day => {
    const value = day[source]
    if (value === null) { connected = false; return '' }
    const command = connected ? 'L' : 'M'
    connected = true
    return `${command} ${x(day.time)} ${y(value)}`
  }).filter(Boolean).join(' ')
}
