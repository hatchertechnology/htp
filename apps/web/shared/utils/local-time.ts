// Local-time display helpers (owner decision Q7). UTC stays in the backend, API
// calls, storage and range math; only instants shown to the viewer are converted.
// Calendar dates are not instants and are never shifted.
const FALLBACK_ZONE = 'UTC'
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const formatters = new Map<string, Intl.DateTimeFormat>()

export function userTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone ? zone : FALLBACK_ZONE
  } catch { return FALLBACK_ZONE }
}

// Built from component options: ECMA-402 throws when dateStyle/timeStyle are
// combined with timeZoneName. A calendar date never carries a zone label.
function formatter(locale: string | undefined, timeZone: string, dateOnly: boolean): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${timeZone}|${dateOnly ? 'date' : 'instant'}`
  const cached = formatters.get(key)
  if (cached) return cached
  const created = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(dateOnly ? {} : { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
    timeZone,
  })
  formatters.set(key, created)
  return created
}

export function formatInstant(iso: string, opts: { timeZone?: string; locale?: string; dateOnly?: boolean } = {}): string {
  if (typeof iso !== 'string' || iso.trim() === '') return iso
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return iso
  try {
    return formatter(opts.locale, opts.timeZone ?? userTimeZone(), opts.dateOnly === true).format(at)
  } catch { return iso }
}

// Uses the same default locale as formatInstant so a label next to a timestamp
// always names the zone the same way (en-GB gives BST, en-US gives GMT+1).
export function zoneLabel(timeZone: string = userTimeZone(), at: Date = new Date()): string {
  try {
    const name = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: 'short' }).formatToParts(at).find(part => part.type === 'timeZoneName')
    return name?.value ?? timeZone
  } catch { return timeZone }
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

const partFormatters = new Map<string, Intl.DateTimeFormat>()

function zonedParts(at: Date, timeZone: string): ZonedParts {
  let formatter = partFormatters.get(timeZone)
  if (!formatter) {
    // en-US so the numeric fields are always ASCII digits (Number() parses them).
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
    partFormatters.set(timeZone, formatter)
  }
  const formatted = formatter.formatToParts(at)
  const read = (type: string) => Number(formatted.find(part => part.type === type)?.value)
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), second: read('second') }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function dayString(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, '0')}-${pad(parts.month)}-${pad(parts.day)}`
}

// Milliseconds the zone is ahead of UTC at that instant (positive east).
function offsetAt(instant: number, timeZone: string): number {
  const parts = zonedParts(new Date(instant), timeZone)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000
}

function localDayOfInstant(instant: number, timeZone: string): string {
  return dayString(zonedParts(new Date(instant), timeZone))
}

export function localDayOf(iso: string, timeZone: string = userTimeZone()): string | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return null
  try { return localDayOfInstant(at.getTime(), timeZone) } catch { return null }
}

function parseDay(day: string): { year: number; month: number; day: number } | null {
  const match = DAY.exec(day)
  if (!match) return null
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const check = new Date(Date.UTC(year, month - 1, date))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null
  return { year, month, day: date }
}

// 00:00 local on `day`, DST-correct without libraries. The one-step offset
// correction is repeated once; of the candidates that land on the requested
// local day the smallest wins, so a nonexistent midnight starts at the first
// existing instant and a repeated midnight uses its first occurrence.
function startOfLocalDay(day: { year: number; month: number; day: number }, timeZone: string): number | null {
  const guess = Date.UTC(day.year, day.month - 1, day.day)
  const expected = dayString(day)
  const candidates = [guess - offsetAt(guess, timeZone)]
  candidates.push(guess - offsetAt(candidates[0]!, timeZone))
  const matching = candidates.filter(instant => localDayOfInstant(instant, timeZone) === expected)
  if (!matching.length) return null
  return Math.min(...matching)
}

function addDays(day: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(day.year, day.month - 1, day.day + days))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

// Half-open UTC epoch bounds of a local calendar day: [00:00 day, 00:00 day+1).
// Returns null for malformed input and for a well-formed calendar day the zone
// skipped entirely (e.g. Pacific/Apia 2011-12-30, which has no local instants),
// so callers must treat null as "no such local day here" and disable that filter
// bound. The end of the day before a skipped day is the instant the clock jumped.
export function localDayBounds(day: string, timeZone: string = userTimeZone()): { start: number; end: number } | null {
  const parsed = parseDay(day)
  if (!parsed) return null
  try {
    const start = startOfLocalDay(parsed, timeZone)
    if (start === null) return null
    // A zone can skip the next local day (date-line moves); the day still ends at
    // the first instant of the next day that exists.
    let cursor = addDays(parsed, 1)
    let end: number | null = null
    for (let step = 0; step < 3 && end === null; step++) {
      end = startOfLocalDay(cursor, timeZone)
      if (end === null) cursor = addDays(cursor, 1)
    }
    if (end === null) return null
    return { start, end }
  } catch { return null }
}
