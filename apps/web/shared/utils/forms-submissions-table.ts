// Pure query helpers for the Forms submissions table. The API stays the source
// of truth and reads remain bounded; sorting, filtering and search run over the
// rows the component has already loaded.
import { localDayBounds, userTimeZone } from './local-time'

export type SubmissionRow = { id: string; received_at: string; status: string; values: Record<string, string> }
export type SubmissionStatus = 'new' | 'reviewed' | 'spam'
export type SortKey = { kind: 'received' } | { kind: 'status' } | { kind: 'field'; key: string }
export type SubmissionQuery = {
  sort: SortKey
  direction: 'asc' | 'desc'
  statuses: SubmissionStatus[]
  from: string
  to: string
  search: string
  // Input days are local calendar days in this zone. The default is the viewer's zone.
  timeZone?: string
}

export const DEFAULT_SUBMISSION_QUERY: SubmissionQuery = {
  sort: { kind: 'received' },
  direction: 'desc',
  statuses: ['new', 'reviewed', 'spam'],
  from: '',
  to: '',
  search: '',
}

const STATUS_ORDER: Record<string, number> = { new: 0, reviewed: 1, spam: 2 }

// Form fields in their declared order, then any extra value keys sorted by key.
// The key set matches the CSV export; labels for extra keys are the keys.
export function submissionColumns(
  fields: ReadonlyArray<{ key: string; label: string }>,
  rows: ReadonlyArray<SubmissionRow>,
): Array<{ key: string; label: string }> {
  const columns: Array<{ key: string; label: string }> = []
  const seen = new Set<string>()
  for (const field of fields) {
    if (seen.has(field.key)) continue
    seen.add(field.key)
    columns.push({ key: field.key, label: field.label })
  }
  const extra = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row.values ?? {})) if (!seen.has(key)) extra.add(key)
  }
  for (const key of [...extra].sort()) columns.push({ key, label: key })
  return columns
}

function receivedValue(row: SubmissionRow): string {
  return typeof row.received_at === 'string' ? row.received_at : ''
}

function receivedTime(row: SubmissionRow): number | null {
  const parsed = Date.parse(row.received_at)
  return Number.isFinite(parsed) ? parsed : null
}

function normalize(value: unknown): string {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
}

function bound(day: string, timeZone: string): { start: number; end: number } | null {
  if (!day) return null
  return localDayBounds(day, timeZone)
}

// Status first, then the half-open local-day range, then a case-insensitive
// NFKC substring search across values (not keys or status). An empty status list
// means all statuses; an empty bound is open. A row with an unparsable
// received_at is excluded when a date bound is active.
export function applySubmissionQuery(rows: ReadonlyArray<SubmissionRow>, query: SubmissionQuery): SubmissionRow[] {
  const timeZone = query.timeZone ?? userTimeZone()
  const statuses = Array.isArray(query.statuses) ? query.statuses : []
  const from = bound(query.from, timeZone)
  const to = bound(query.to, timeZone)
  const term = normalize(query.search).trim()

  const filtered: Array<{ row: SubmissionRow; index: number }> = []
  rows.forEach((row, index) => {
    if (statuses.length && !statuses.includes(row.status as SubmissionStatus)) return
    if (from || to) {
      const at = receivedTime(row)
      if (at === null) return
      if (from && at < from.start) return
      if (to && at >= to.end) return
    }
    if (term) {
      const values = Object.values(row.values ?? {})
      if (!values.some(value => normalize(value).includes(term))) return
    }
    filtered.push({ row, index })
  })

  const direction = query.direction === 'asc' ? 1 : -1
  const sort = query.sort
  filtered.sort((left, right) => {
    let compared = 0
    if (sort.kind === 'received') {
      const a = receivedValue(left.row), b = receivedValue(right.row)
      compared = a === b ? 0 : a < b ? -1 : 1
      compared *= direction
    } else if (sort.kind === 'status') {
      compared = (STATUS_ORDER[left.row.status] ?? 99) - (STATUS_ORDER[right.row.status] ?? 99)
      compared *= direction
    } else {
      const a = String(left.row.values?.[sort.key] ?? '').trim()
      const b = String(right.row.values?.[sort.key] ?? '').trim()
      // Empty values stay last in both directions.
      if (!a && b) return 1
      if (a && !b) return -1
      compared = a === b ? 0 : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) * direction
    }
    if (compared) return compared
    // Stable tie-break: newest received first, then id.
    const a = receivedValue(left.row), b = receivedValue(right.row)
    if (a !== b) return a < b ? 1 : -1
    if (left.row.id === right.row.id) return left.index - right.index
    return left.row.id < right.row.id ? -1 : 1
  })
  return filtered.map(entry => entry.row)
}
