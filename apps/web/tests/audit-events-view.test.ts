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
    expect(some.text).toMatch(/historical/)
  })
  it('warns when availability is not reported and passes other values through', () => {
    expect(availabilityNotice(null, 0, 'events').text).toMatch(/cannot be read as a clean result/)
    expect(availabilityNotice('active', 0, 'events')).toEqual({ tone: 'status', text: 'Producer availability: active.' })
  })
  it('keeps the empty text separate from the availability warning', () => {
    expect(emptyText('events')).toBe('No audit events are stored for this website.')
    expect(emptyText('episodes')).toBe('No provider failure episodes are stored for this website.')
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
