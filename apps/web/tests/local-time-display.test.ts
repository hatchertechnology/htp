import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { formatInstant, zoneLabel } from '../shared/utils/local-time'

// The reporting components cannot be mounted here (the vitest config has no Vue
// SFC plugin), so this file extracts their formatter calls from source and
// checks them against the shared helper in America/New_York.
const NY = 'America/New_York'
const source = (name: string) => readFileSync(new URL(`../app/components/${name}`, import.meta.url), 'utf8')

it('renders a saved instant in the viewer zone with a short label, while the raw UTC value stays available', () => {
  expect(formatInstant('2026-11-24T14:03:00Z', { timeZone: NY })).toContain('Nov 24, 2026')
  expect(formatInstant('2026-11-24T14:03:00Z', { timeZone: NY })).toContain('9:03')
  expect(formatInstant('2026-11-24T14:03:00Z', { timeZone: NY })).toContain('EST')
  expect(formatInstant('2026-07-24T14:03:00Z', { timeZone: NY })).toContain('10:03')
  expect(formatInstant('2026-07-24T14:03:00Z', { timeZone: NY })).toContain('EDT')
  expect(zoneLabel(NY, new Date('2026-11-24T14:03:00Z'))).toBe('EST')
  expect(zoneLabel(NY, new Date('2026-07-24T14:03:00Z'))).toBe('EDT')
})

const displays: { file: string; bindings: string[]; labels: string[] }[] = [
  { file: 'RepositoryHistory.vue', bindings: ['commit.committed_at', 'commit.observed_at', 'binding.last_checked_at'], labels: ['Committed ({{ zone }})', 'First observed ({{ zone }})', 'Times shown in your timezone ({{ zone }})'] },
  { file: 'SeosmithDashboard.vue', bindings: ['entry.first_observed', 'entry.last_observed', 'item.scan_at', 'row.scan_at', 'run.scan_at', 'selected.scan_at'], labels: ['Scan time ({{ zone }})'] },
  { file: 'SeosmithTrend.vue', bindings: [], labels: ['Scan time ({{ zone }})'] },
  { file: 'ReportSyncNotice.vue', bindings: ['sync.fetched_at'], labels: ['Last synced'] },
  { file: 'SearchEvidence.vue', bindings: ['data.sync.fetched_at'], labels: ['Exact snapshot saved'] },
  { file: 'SearchDashboard.vue', bindings: ['indexStatus.lastCrawlTime', 'crawlEvidence.scan_at', 'observation.observed_at'], labels: [] },
  { file: 'RepositoryIssues.vue', bindings: ['issue.updated_at'], labels: [] },
  { file: 'BusinessDashboard.vue', bindings: ['change.observed_at', 'change.previous_observed_at'], labels: ['change observations show in your timezone ({{ zone }})'] },
  { file: 'CombinedPerformance.vue', bindings: [], labels: ['Commit markers show exact commit times in your timezone ({{ zone }})'] },
]

it.each(displays)('$file displays instants through formatInstant and carries the UTC ISO value', ({ file, bindings, labels }) => {
  const text = source(file)
  expect(text).toMatch(/import \{[^}]*formatInstant[^}]*\} from '#shared\/utils\/local-time'/)
  expect(text).toContain('formatInstant(')
  for (const binding of bindings) expect(text).toContain(`datetime="${binding}"`)
  for (const label of labels) expect(text).toContain(label)
})

it('does not format an instant as a bare UTC string anywhere in the sweep', () => {
  const files = ['RepositoryHistory.vue', 'CombinedPerformance.vue', 'SeosmithDashboard.vue', 'SeosmithTrend.vue', 'ReportSyncNotice.vue', 'SearchEvidence.vue', 'SearchDashboard.vue', 'RepositoryIssues.vue', 'BusinessDashboard.vue']
  for (const file of files) {
    const text = source(file)
    expect(text, file).not.toMatch(/toISOString\(\)\.replace\('T'/)
    expect(text, file).not.toMatch(/toISOString\(\)\.slice\(0, 19\)/)
    expect(text, file).not.toMatch(/\+\s*' UTC'/)
    expect(text, file).not.toMatch(/new Date\([^)]*\)\.toLocaleString\(\)/)
  }
})

it('keeps commit markers bucketed by UTC day and shows the exact time as an instant', () => {
  const combined = source('CombinedPerformance.vue')
  // Bucketing is untouched: the marker day comes from the UTC ISO prefix.
  expect(combined).toContain('commit.committed_at.slice(0, 10)')
  expect(combined).toContain('formatInstant(commit.committed_at)')
  expect(combined).toContain(':title="commit.committed_at"')
})
