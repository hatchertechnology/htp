import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBMISSION_QUERY, applySubmissionQuery, submissionColumns,
  type SubmissionQuery, type SubmissionRow,
} from '../shared/utils/forms-submissions-table'

const row = (id: string, received_at: string, status = 'new', values: Record<string, string> = {}): SubmissionRow =>
  ({ id, received_at, status, values })

function query(overrides: Partial<SubmissionQuery> = {}): SubmissionQuery {
  return {
    ...DEFAULT_SUBMISSION_QUERY,
    sort: { ...DEFAULT_SUBMISSION_QUERY.sort },
    statuses: [...DEFAULT_SUBMISSION_QUERY.statuses],
    timeZone: 'America/New_York',
    ...overrides,
  }
}

describe('submission columns', () => {
  it('keeps form field order, then sorts extra value keys, with the same key set as CSV', () => {
    const fields = [{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }]
    const rows = [row('a', '2026-11-24T12:00:00Z', 'new', { email: 'a@example.test', score: '10', note: 'hi', name: 'Ada' })]
    expect(submissionColumns(fields, rows)).toEqual([
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'note', label: 'note' },
      { key: 'score', label: 'score' },
    ])
  })
})

describe('submission query defaults', () => {
  it('sorts received newest first with all statuses and no filters', () => {
    const rows = [
      row('old', '2026-11-20T12:00:00Z'),
      row('new', '2026-11-24T12:00:00Z'),
      row('middle', '2026-11-22T12:00:00Z'),
    ]
    expect(applySubmissionQuery(rows, query()).map(item => item.id)).toEqual(['new', 'middle', 'old'])
  })
})

describe('status and field sorting', () => {
  const rows = [
    row('spam', '2026-11-24T12:00:00Z', 'spam', { score: '2' }),
    row('new', '2026-11-23T12:00:00Z', 'new', { score: '10' }),
    row('reviewed', '2026-11-22T12:00:00Z', 'reviewed', { score: '1' }),
    row('empty', '2026-11-21T12:00:00Z', 'new', { score: '' }),
  ]
  it('orders status new < reviewed < spam in both directions', () => {
    expect(applySubmissionQuery(rows, query({ sort: { kind: 'status' }, direction: 'asc' })).map(item => item.id))
      .toEqual(['new', 'empty', 'reviewed', 'spam'])
    expect(applySubmissionQuery(rows, query({ sort: { kind: 'status' }, direction: 'desc' })).map(item => item.id))
      .toEqual(['spam', 'reviewed', 'new', 'empty'])
  })
  it('sorts fields numerically and keeps empty values last in both directions', () => {
    expect(applySubmissionQuery(rows, query({ sort: { kind: 'field', key: 'score' }, direction: 'asc' })).map(item => item.id))
      .toEqual(['reviewed', 'spam', 'new', 'empty'])
    expect(applySubmissionQuery(rows, query({ sort: { kind: 'field', key: 'score' }, direction: 'desc' })).map(item => item.id))
      .toEqual(['new', 'spam', 'reviewed', 'empty'])
  })
  it('breaks ties by received_at descending and then id', () => {
    const tied = [
      row('b', '2026-11-24T12:00:00Z', 'new'),
      row('a', '2026-11-24T12:00:00Z', 'new'),
      row('c', '2026-11-25T12:00:00Z', 'new'),
    ]
    expect(applySubmissionQuery(tied, query({ sort: { kind: 'status' }, direction: 'asc' })).map(item => item.id))
      .toEqual(['c', 'a', 'b'])
  })
})

describe('status, local-day and search filters', () => {
  it('filters by the selected statuses and treats an empty list as all', () => {
    const rows = [row('a', '2026-11-24T12:00:00Z', 'new'), row('b', '2026-11-24T12:00:00Z', 'spam')]
    expect(applySubmissionQuery(rows, query({ statuses: ['spam'] })).map(item => item.id)).toEqual(['b'])
    expect(applySubmissionQuery(rows, query({ statuses: [] })).map(item => item.id)).toEqual(['a', 'b'])
  })
  it('converts a local From/To day to UTC instants before comparing received_at', () => {
    const rows = [
      row('inside', '2026-11-25T03:00:00Z'), // Nov 24 22:00 EST
      row('before', '2026-11-24T04:59:59Z'), // Nov 23 23:59 EST
      row('after', '2026-11-25T05:00:00Z'), // Nov 25 00:00 EST
    ]
    const result = applySubmissionQuery(rows, query({ from: '2026-11-24', to: '2026-11-24' }))
    expect(result.map(item => item.id)).toEqual(['inside'])
  })
  it('includes the full 25-hour DST fall-back day', () => {
    const rows = [
      row('first', '2026-11-01T04:00:00Z'), // 00:00 EDT
      row('last', '2026-11-02T04:59:59Z'), // 23:59:59 EST
      row('outside', '2026-11-02T05:00:00Z'),
    ]
    expect(applySubmissionQuery(rows, query({ from: '2026-11-01', to: '2026-11-01' })).map(item => item.id))
      .toEqual(['last', 'first'])
  })
  it('returns no rows when a requested local day does not exist in the zone', () => {
    const rows = [row('one', '2011-12-29T12:00:00Z'), row('two', '2011-12-31T12:00:00Z')]
    expect(applySubmissionQuery(rows, query({ from: '2011-12-30', timeZone: 'Pacific/Apia' }))).toEqual([])
    expect(applySubmissionQuery(rows, query({ to: '2011-12-30', timeZone: 'Pacific/Apia' }))).toEqual([])
  })
  it('searches values case- and NFKC-insensitively, not keys or status', () => {
    const rows = [
      row('match', '2026-11-24T12:00:00Z', 'new', { name: 'Café', note: 'Hello World' }),
      row('document', '2026-11-23T12:00:00Z', 'new', { name: 'Other', note: 'NO MATCH' }),
      row('key-only', '2026-11-22T12:00:00Z', 'new', { special: 'value' }),
    ]
    expect(applySubmissionQuery(rows, query({ search: 'CAFE\u0301' })).map(item => item.id)).toEqual(['match'])
    expect(applySubmissionQuery(rows, query({ search: 'hello' })).map(item => item.id)).toEqual(['match'])
    expect(applySubmissionQuery(rows, query({ search: 'special' })).map(item => item.id)).toEqual([])
    expect(applySubmissionQuery(rows, query({ search: 'reviewed' })).map(item => item.id)).toEqual([])
  })
  it('returns untrusted strings unchanged', () => {
    const rows = [row('script', '2026-11-24T12:00:00Z', 'new', { name: '<script>unsafe</script>' })]
    expect(applySubmissionQuery(rows, query({ search: '<script>' }))[0]!.values.name).toBe('<script>unsafe</script>')
  })
})
