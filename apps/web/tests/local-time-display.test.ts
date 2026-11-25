import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { formatInstant, zoneLabel } from '../shared/utils/local-time'

// The reporting components cannot be mounted here (the vitest config has no Vue
// SFC plugin), so this file extracts their formatter calls from source and
// checks them against the shared helper in America/New_York.
const NY = 'America/New_York'
const source = (name: string) => readFileSync(new URL(`../app/components/${name}`, import.meta.url), 'utf8')
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

it('renders a saved instant in the viewer zone with a short label, while the raw UTC value stays available', () => {
  expect(formatInstant('2026-11-24T14:03:00Z', { timeZone: NY })).toContain('Nov 24, 2026')
  expect(formatInstant('2026-11-24T14:03:00Z', { timeZone: NY })).toContain('9:03')
  expect(formatInstant('2026-11-24T14:03:00Z', { timeZone: NY })).toContain('EST')
  expect(formatInstant('2026-07-24T14:03:00Z', { timeZone: NY })).toContain('10:03')
  expect(formatInstant('2026-07-24T14:03:00Z', { timeZone: NY })).toContain('EDT')
  expect(zoneLabel(NY, new Date('2026-11-24T14:03:00Z'))).toBe('EST')
  expect(zoneLabel(NY, new Date('2026-07-24T14:03:00Z'))).toBe('EDT')
})

it('labels each zone exactly the way formatInstant renders it, independent of the host locale', () => {
  for (const zone of [NY, 'Europe/London', 'Asia/Kolkata']) {
    const instant = '2026-07-01T12:00:00Z'
    expect(formatInstant(instant, { timeZone: zone }), zone).toContain(zoneLabel(zone, new Date(instant)))
  }
})

type Display = { file: string; times: { binding: string; formatter?: string }[]; labels: string[] }

const displays: Display[] = [
  {
    file: 'RepositoryHistory.vue',
    times: [{ binding: 'commit.committed_at' }, { binding: 'binding.last_checked_at' }, { binding: 'commit.observed_at' }],
    labels: ['Committed ({{ zone() }})', 'First observed ({{ zone() }})', 'Times shown in your timezone ({{ zone() }})'],
  },
  {
    file: 'SeosmithDashboard.vue',
    times: ['entry.first_observed', 'entry.last_observed', 'item.scan_at', 'row.scan_at', 'run.scan_at', 'selected.scan_at', 'selected.received_at'].map(binding => ({ binding, formatter: 'stamp' })),
    labels: ['Scan time ({{ zone() }})'],
  },
  { file: 'ReportSyncNotice.vue', times: [{ binding: 'sync.fetched_at' }], labels: ['Last synced'] },
  { file: 'SearchEvidence.vue', times: [{ binding: 'data.sync.fetched_at' }], labels: ['Exact snapshot saved'] },
  {
    file: 'SearchDashboard.vue',
    times: ['indexStatus.lastCrawlTime', 'crawlEvidence.scan_at', 'observation.observed_at'].map(binding => ({ binding, formatter: 'time' })),
    labels: [],
  },
  { file: 'RepositoryIssues.vue', times: [{ binding: 'issue.updated_at' }], labels: [] },
  {
    file: 'BusinessDashboard.vue',
    times: [{ binding: 'change.observed_at' }, { binding: 'change.previous_observed_at' }],
    labels: ['change observations show in your timezone ({{ zone() }})'],
  },
]

it.each(displays)('$file renders visible text through the formatter in the element that carries the UTC ISO', ({ file, times, labels }) => {
  const text = source(file)
  expect(text).toMatch(/import \{[^}]*formatInstant[^}]*\} from '#shared\/utils\/local-time'/)
  for (const { binding, formatter = 'formatInstant' } of times) {
    const name = escape(binding)
    const pattern = new RegExp(`<time\\b[^>]*:datetime="${name}"[^>]*>\\{\\{ ${formatter}\\(${name}\\) \\}\\}</time>`)
    expect(text, `${file}: ${binding}`).toMatch(pattern)
  }
  for (const label of labels) expect(text, file).toContain(label)
})

it('wraps the finding-history failure bounds in the shared instant element', () => {
  const text = source('SeosmithDashboard.vue')
  expect(text).toContain(':datetime="historyFailures[historyFailures.length - 1]!.scan_at"')
  expect(text).toContain(':datetime="historyFailures[0]!.scan_at"')
  expect(text).toMatch(/<time :datetime="historyFailures\[0\]!\.scan_at" :title="historyFailures\[0\]!\.scan_at">\{\{ stamp\(historyFailures\[0\]!\.scan_at\) \}\}<\/time>/)
})

it('keeps the chart caption and point labels in the viewer zone', () => {
  const trend = source('SeosmithTrend.vue')
  expect(trend).toContain('Scan time ({{ zone() }})')
  expect(trend).toContain(':aria-label="`${stamp(point.time)}:')
  expect(trend).toContain('<title>{{ new Date(point.time).toISOString() }}')
  const combined = source('CombinedPerformance.vue')
  expect(combined).toContain('formatInstant(commit.committed_at)')
  expect(combined).toContain(':title="commit.committed_at"')
  expect(combined).toContain('in your timezone ({{ zone() }})')
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
