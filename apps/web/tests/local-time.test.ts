import { expect, it } from 'vitest'
import { formatInstant, localDayBounds, localDayOf, userTimeZone, zoneLabel } from '../shared/utils/local-time'

const NY = 'America/New_York'
const KOLKATA = 'Asia/Kolkata'
const at = (value: string) => Date.parse(value)

function dayList(): string[] {
  const days: string[] = []
  for (let time = Date.UTC(2026, 0, 1); time < Date.UTC(2027, 0, 1); time += 86400_000) days.push(new Date(time).toISOString().slice(0, 10))
  return days
}

function localHour(instant: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(instant))
}

it('runs the suite in the fixed America/New_York zone (UTC-5 in January), or UTC for the cross-check', () => {
  const offset = new Date(2026, 0, 1).getTimezoneOffset()
  if (process.env.TZ === 'UTC') {
    expect(offset).toBe(0)
    expect(userTimeZone()).toBe('UTC')
  } else {
    // The zone comes from the `test` script; run `npm test` (or the cross-check).
    expect(process.env.TZ, 'run the suite with npm test (TZ=America/New_York)').toBe(NY)
    expect(offset).toBe(300)
    expect(userTimeZone()).toBe(NY)
  }
})

it('formats an instant in the viewer zone with a short zone name', () => {
  expect(formatInstant('2026-11-24T14:03:00Z', { timeZone: NY })).toContain('9:03')
  expect(formatInstant('2026-11-24T14:03:00Z', { timeZone: NY })).toContain('EST')
  expect(formatInstant('2026-07-24T14:03:00Z', { timeZone: NY })).toContain('10:03')
  expect(formatInstant('2026-07-24T14:03:00Z', { timeZone: NY })).toContain('EDT')
  expect(formatInstant('2026-11-24T14:03:00Z', { timeZone: KOLKATA })).toContain('GMT+5:30')
})

it('leaves invalid or empty instants unchanged and never adds a zone to a calendar date', () => {
  expect(formatInstant('not a date')).toBe('not a date')
  expect(formatInstant('')).toBe('')
  expect(formatInstant('2026-11-24T14:03:00Z', { timeZone: NY, dateOnly: true })).toBe('Nov 24, 2026')
})

it('labels a zone with the same short name formatInstant renders', () => {
  expect(zoneLabel(NY, new Date('2026-11-24T14:03:00Z'))).toBe('EST')
  expect(zoneLabel(NY, new Date('2026-07-24T14:03:00Z'))).toBe('EDT')
  for (const [zone, instant] of [[NY, '2026-07-24T14:03:00Z'], ['Europe/London', '2026-07-01T12:00:00Z'], [KOLKATA, '2026-11-24T14:03:00Z']]) {
    expect(formatInstant(instant, { timeZone: zone }), zone).toContain(zoneLabel(zone, new Date(instant)))
  }
})

it('reads the local calendar day of an instant', () => {
  expect(localDayOf('2026-11-25T03:00:00Z', NY)).toBe('2026-11-24')
  expect(localDayOf('2026-11-25T05:00:00Z', NY)).toBe('2026-11-25')
  expect(localDayOf('nope', NY)).toBeNull()
  expect(localDayOf('', NY)).toBeNull()
})

it('bounds a local day in UTC and spans the DST days correctly', () => {
  expect(localDayBounds('2026-11-24', NY)).toEqual({ start: at('2026-11-24T05:00:00Z'), end: at('2026-11-25T05:00:00Z') })
  expect(localDayBounds('2026-03-08', NY)).toEqual({ start: at('2026-03-08T05:00:00Z'), end: at('2026-03-09T04:00:00Z') })
  expect(localDayBounds('2026-11-01', NY)).toEqual({ start: at('2026-11-01T04:00:00Z'), end: at('2026-11-02T05:00:00Z') })
  const spring = localDayBounds('2026-03-08', NY)!
  const fall = localDayBounds('2026-11-01', NY)!
  expect((spring.end - spring.start) / 3600_000).toBe(23)
  expect((fall.end - fall.start) / 3600_000).toBe(25)
})

it('uses offsets for a zone without an abbreviation', () => {
  expect(localDayBounds('2026-11-24', KOLKATA)).toEqual({ start: at('2026-11-23T18:30:00Z'), end: at('2026-11-24T18:30:00Z') })
})

it('returns null for a calendar day the zone skipped entirely, not just for bad input', () => {
  // Samoa skipped 2011-12-30 when it crossed the date line.
  expect(localDayBounds('2011-12-30', 'Pacific/Apia')).toBeNull()
  expect(localDayBounds('2011-12-29', 'Pacific/Apia')).toEqual({ start: at('2011-12-29T10:00:00Z'), end: at('2011-12-30T10:00:00Z') })
  expect(localDayBounds('2011-12-31', 'Pacific/Apia')).toEqual({ start: at('2011-12-30T10:00:00Z'), end: at('2011-12-31T10:00:00Z') })
})

it('rejects malformed days', () => {
  for (const day of ['2026-02-30', '2026-13-01', '24-11-2026', '2026-1-24', '', 'today']) expect(localDayBounds(day, NY)).toBeNull()
})

it('starts a day whose local midnight does not exist at the first existing instant', () => {
  for (const zone of ['America/Santiago', 'America/Havana']) {
    const days = dayList()
    const lengths = days.map(day => {
      const bounds = localDayBounds(day, zone)
      expect(bounds).not.toBeNull()
      return Math.round((bounds!.end - bounds!.start) / 3600_000)
    })
    const short = days.filter((_, index) => lengths[index] === 23)
    const long = days.filter((_, index) => lengths[index] === 25)
    expect(short.length, `${zone} 2026 has a spring-forward day`).toBeGreaterThan(0)
    expect(long.length, `${zone} 2026 has a fall-back day`).toBeGreaterThan(0)
    for (const day of short) {
      const bounds = localDayBounds(day, zone)!
      // Local midnight is skipped, so the day begins at 01:00 local.
      expect(localHour(bounds.start, zone)).toBe('01')
      expect(localDayOf(new Date(bounds.start).toISOString(), zone)).toBe(day)
    }
    for (const day of long) {
      const bounds = localDayBounds(day, zone)!
      // The repeated hour is chosen by its first occurrence: 00:00 local, and the
      // instant before the start belongs to the previous local day.
      expect(localHour(bounds.start, zone)).toBe('00')
      expect(localDayOf(new Date(bounds.start - 1).toISOString(), zone)).not.toBe(day)
      expect((bounds.end - bounds.start) / 3600_000).toBe(25)
    }
  }
})
