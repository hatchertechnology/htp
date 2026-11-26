import { describe, expect, it } from 'vitest'
import {
  EVENT_PAGE_SIZE, availabilityNotice, emptyText, episodeState, kindLabel, nextEventsQuery,
  parseEpisodesPage, parseEventsPage, unknownText, type EpisodeRow,
} from '../shared/utils/audit-events-view'
import { formatInstant } from '../shared/utils/local-time'

const id = '00000000-0000-4000-8000-0000000000a1'
const event = { id, delivery_id: '00000000-0000-4000-8000-0000000000b1', baseline_id: id, semantics_version: 1, entity_id: 'sha256:a', rule: 'missing_title', kind: 'new', severity: 'alert', source_locator: 'https://example.test/', created_at: '2026-11-21T01:30:00+00:00' }
const eventsPage = (over: Record<string, unknown> = {}) => ({ semantics_version: 1, events: [event], has_more: false, next_cursor: null, availability: 'producer_unavailable', ...over })
const episode = { id, source: 'google', job_id: null, error_class: 'quota', opened_at: '2026-11-20T12:00:00+00:00', recovered_at: null }
const episodesPage = (over: Record<string, unknown> = {}) => ({ version: 1, episodes: [episode], has_more: false, next_cursor: null, availability: 'producer_unavailable', ...over })

describe('events page parsing', () => {
  it('reads rows with explicit availability and keeps unreported fields null', () => {
    const page = parseEventsPage(eventsPage({ events: [{ id, kind: 'reopened' }] }))!
    expect(page.availability).toBe('producer_unavailable')
    expect(page.rows).toEqual([{ id, delivery_id: null, kind: 'reopened', severity: null, rule: null, entity_id: null, source_locator: null, created_at: null }])
    expect(unknownText(page.rows[0]!.severity)).toBe('Unknown')
  })
  it('requires the paired cursor exactly when more is advertised', () => {
    const cursor = { before: '2026-11-21T01:30:00+00:00', before_id: id }
    expect(parseEventsPage(eventsPage({ has_more: true, next_cursor: cursor }))!.nextCursor).toEqual(cursor)
    expect(parseEventsPage(eventsPage({ has_more: true, next_cursor: { before: cursor.before } }))).toBeNull()
    expect(parseEventsPage(eventsPage({ has_more: true, next_cursor: null }))).toBeNull()
    expect(parseEventsPage(eventsPage({ has_more: false, next_cursor: cursor }))).toBeNull()
  })
  it.each([null, 'x', [], {}, eventsPage({ semantics_version: 2 }), eventsPage({ events: 'none' }), eventsPage({ events: [{ kind: 'new' }] }), eventsPage({ events: ['row'] }), eventsPage({ has_more: 'no' })])('treats malformed page %j as a read failure, never an empty list', raw => {
    expect(parseEventsPage(raw)).toBeNull()
  })
  it('reads episodes with their own version field', () => {
    const page = parseEpisodesPage(episodesPage())!
    expect(page.rows[0]).toEqual(episode)
    expect(parseEpisodesPage(eventsPage())).toBeNull()
    expect(parseEventsPage(episodesPage())).toBeNull()
  })
})

describe('availability is never a clean result', () => {
  it('warns with and without rows while the producer is unavailable', () => {
    const empty = availabilityNotice('producer_unavailable', 0, 'events')
    expect(empty.tone).toBe('notice')
    expect(empty.text).toMatch(/not a clean result/)
    expect(empty.text).toMatch(/no new or regressed issues/)
    const some = availabilityNotice('producer_unavailable', 3, 'episodes')
    expect(some.tone).toBe('notice')
    expect(some.text).toMatch(/missing or delayed/)
  })
  it('warns when availability is not reported', () => {
    expect(availabilityNotice(null, 0, 'events').text).toMatch(/cannot be read as a clean result/)
    expect(availabilityNotice(null, 0, 'events').tone).toBe('notice')
  })
  it('only producer_active reads an empty list as no events', () => {
    const active = availabilityNotice('producer_active', 0, 'events')
    expect(active.tone).toBe('status')
    expect(active.text).toMatch(/empty list means no events/)
    expect(availabilityNotice('producer_active', 0, 'episodes').text).toMatch(/no episodes are stored/)
    expect(availabilityNotice('producer_active', 2, 'events').text).not.toMatch(/empty/)
    expect(parseEventsPage(eventsPage({ availability: 'producer_active' }))!.availability).toBe('producer_active')
  })
  it.each([
    ['producer_unavailable', /not active yet/],
    ['producer_not_enqueuing', /not queueing new events/],
    ['producer_starting', /has not run yet/],
    ['producer_stale', /not run for at least 5 minutes/],
    ['producer_degraded', /errors or delays/],
  ])('%s is a notice and an empty list is never clean', (code, lead) => {
    const empty = availabilityNotice(code, 0, 'events')
    expect(empty.tone).toBe('notice')
    expect(empty.text).toMatch(lead)
    expect(empty.text).toMatch(/not a clean result/)
    expect(empty.text).not.toMatch(/no events are stored/)
    const some = availabilityNotice(code, 3, 'events')
    expect(some.tone).toBe('notice')
    expect(some.text).toMatch(/missing or delayed/)
  })
  it('treats an unrecognised value as not clean', () => {
    const n = availabilityNotice('active', 0, 'events')
    expect(n.tone).toBe('notice')
    expect(n.text).toMatch(/does not recognise/)
    expect(n.text).toMatch(/not a clean result/)
  })
  it('reads the producer object and shows queue counts, lower bounds when capped', () => {
    const producer = { processing_enabled: true, enqueue_enabled: true, last_run_at: '2026-11-26T12:00:00Z', last_success_at: null, last_outcome: 'retry', pending: 3, held: 1, held_by_reason: { poison: 1 }, counts_capped: true }
    const page = parseEventsPage(eventsPage({ availability: 'producer_degraded', producer }))!
    expect(page.producer).toEqual({ pending: 3, held: 1, countsCapped: true, lastRunAt: '2026-11-26T12:00:00Z' })
    expect(availabilityNotice('producer_degraded', 0, 'events', page.producer).text).toMatch(/At least 3 pending and 1 held/)
    expect(availabilityNotice('producer_degraded', 0, 'events', { ...page.producer!, countsCapped: false }).text).toMatch(/ 3 pending and 1 held/)
    expect(availabilityNotice('producer_stale', 0, 'events', { pending: 0, held: 0, countsCapped: false, lastRunAt: null }).text).not.toMatch(/pending/)
  })
  it('drops a malformed producer object without failing the page or clearing availability', () => {
    for (const producer of ['x', 5, [], { pending: -1, held: 'a' }]) {
      const page = parseEventsPage(eventsPage({ availability: 'producer_stale', producer }))!
      expect(page.availability).toBe('producer_stale')
      expect(page.producer === null || (page.producer.pending === null && page.producer.held === null)).toBe(true)
    }
    expect(parseEventsPage(eventsPage())!.producer).toBeNull()
    expect(parseEpisodesPage(episodesPage({ availability: 'producer_active', producer: { operations_enabled: true } }))!.availability).toBe('producer_active')
  })
  it('says nothing is stored only when producer_active', () => {
    expect(emptyText('events', 'producer_active')).toBe('No audit events are stored for this website.')
    expect(emptyText('episodes', 'producer_active')).toBe('No provider failure episodes are stored for this website.')
  })
  it.each([
    ['producer_unavailable', /Event processing is off/],
    ['producer_not_enqueuing', /Not enqueuing yet/],
    ['producer_starting', /Starting: the runner has not run yet/],
    ['producer_stale', /Stale: no recent run/],
    ['producer_degraded', /Degraded: the last run had errors or delays/],
  ])('%s gives every empty list a state-specific heading that never says none', (code, lead) => {
    for (const noun of ['events', 'episodes'] as const) {
      const text = emptyText(noun, code)
      expect(text).toMatch(lead)
      expect(text).toMatch(/not a clean result/)
      expect(text).toMatch(new RegExp(`${noun} may be missing or delayed`))
      expect(text).not.toMatch(/are stored/)
    }
  })
  it('never reads an unreported or unrecognised code as an empty history', () => {
    const unreported = emptyText('events', null)
    expect(unreported).toMatch(/availability was not reported/)
    expect(unreported).toMatch(/not a clean result/)
    const unrecognised = emptyText('events', 'active')
    expect(unrecognised).toMatch(/does not recognise/)
    expect(unrecognised).toMatch(/not a clean result/)
    for (const code of [null, 'active', 'producer_unavailable', 'producer_degraded']) {
      expect(emptyText('events', code)).not.toMatch(/are stored/)
    }
  })
})

describe('episode and event labels', () => {
  const row = (over: Partial<EpisodeRow>): EpisodeRow => ({ ...episode, ...over })
  it('distinguishes open, recovered and unknown episodes', () => {
    expect(episodeState(row({}))).toBe('open')
    expect(episodeState(row({ recovered_at: '2026-11-21T00:00:00Z' }))).toBe('recovered')
    expect(episodeState(row({ opened_at: null }))).toBe('unknown')
  })
  it('labels known kinds and passes unknown kinds through as text', () => {
    expect(kindLabel('severity_increased')).toBe('Severity increased')
    expect(kindLabel('future_kind')).toBe('future kind')
    expect(kindLabel(null)).toBe('Unknown')
    expect(kindLabel('constructor')).toBe('constructor')
    expect(typeof kindLabel('__proto__')).toBe('string')
  })
})

describe('paging query', () => {
  it('asks for the page size and sends the persisted cursor pair together', () => {
    expect(nextEventsQuery(null)).toEqual({ p_limit: EVENT_PAGE_SIZE })
    expect(nextEventsQuery({ before: '2026-11-21T01:30:00+00:00', before_id: id })).toEqual({ p_limit: EVENT_PAGE_SIZE, p_before: '2026-11-21T01:30:00+00:00', p_before_id: id })
  })
})

describe('local time', () => {
  it('shows stored UTC instants in the viewer zone, with the zone named', () => {
    expect(formatInstant('2026-11-21T01:30:00+00:00', { timeZone: 'America/New_York', locale: 'en-US' })).toBe('Nov 20, 2026, 8:30 PM EST')
  })
})
