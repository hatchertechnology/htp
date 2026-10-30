import { expect, it } from 'vitest'
import { timelineCommits, timelineDays, timelinePath } from '../shared/utils/performance-timeline'
import type { SearchReport } from '../shared/types/search'
import type { RepositoryBinding, RepositoryCommit } from '../shared/types/repository'
const search = { daily: { rows: [{ keys: ['2026-10-02'], clicks: 0, impressions: 10, ctr: 0, position: 4 }, { keys: ['2026-10-04'], clicks: 3, impressions: 20, ctr: .15, position: 2 }] } } as SearchReport
it('aligns different provider date formats and preserves missing values separately from zero', () => {
  const onsite = { metricHeaders: [{ name: 'sessions' }], rows: [{ dimensionValues: [{ value: '20261002' }], metricValues: [{ value: '0' }] }, { dimensionValues: [{ value: '20261004' }], metricValues: [{ value: '12' }] }] }
  const days = timelineDays('2026-10-02', '2026-10-04', search, onsite, 'clicks', 'sessions')
  expect(days.map(d => [d.date, d.search, d.onsite])).toEqual([['2026-10-02', 0, 0], ['2026-10-03', null, null], ['2026-10-04', 3, 12]])
  expect(timelinePath(days, 'search', v => v, v => v)).toMatch(/^M .+ 0 M .+ 3$/)
  expect(timelinePath(days, 'search', v => v, v => v)).not.toContain(' L ')
  expect(timelineDays('2026-10-02', '2026-10-04', search, onsite, 'ctr', 'engagementRate')[0]).toMatchObject({ search: 0, onsite: null })
})
it('handles single-day ranges and refuses invalid or unbounded dates', () => {
  expect(timelineDays('2026-10-02', '2026-10-02', search, undefined, 'clicks', 'sessions')).toHaveLength(1)
  expect(timelineDays('2026-02-30', '2026-10-02', search, undefined, 'clicks', 'sessions')).toEqual([])
  expect(timelineDays('2020-01-01', '2026-10-02', search, undefined, 'clicks', 'sessions')).toEqual([])
})
it('keeps every primary-branch commit, including multiple same-day timestamps, and excludes other bindings', () => {
  const binding = { repository_url: 'https://github.com/example/site', branch: 'main' } as RepositoryBinding
  const commit = (sha: string, time: string, branch = 'main') => ({ sha, committed_at: time, branch, repository_url: binding.repository_url }) as RepositoryCommit
  const rows = [commit('first', '2026-10-02T00:00:00Z'), commit('second', '2026-10-02T23:59:59Z'), commit('first', '2026-10-02T00:00:00Z'), commit('feature', '2026-10-02T12:00:00Z', 'feature'), commit('outside', '2026-10-03T00:00:00Z'), { ...commit('old', '2026-10-02T12:00:00Z'), repository_url: 'https://github.com/example/old' }]
  expect(timelineCommits(rows, binding, '2026-10-02', '2026-10-02').map(c => c.sha)).toEqual(['first', 'second'])
  expect(timelineCommits([commit('legacy', '2026-10-02T12:00:00Z', 'master')], { ...binding, branch: 'master' }, '2026-10-02', '2026-10-02')).toHaveLength(1)
  expect(timelineCommits(rows, null, '2026-10-02', '2026-10-02')).toEqual([])
})
