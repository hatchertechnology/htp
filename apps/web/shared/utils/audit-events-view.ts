// Read-only view model for the stored audit events and provider operational
// episodes (H15). Pure and total: a malformed page is `null` (the panel shows a
// read failure), never an empty list, and an unreported value is `unknown`.
export type EventCursor = { before: string; before_id: string }
export type EventRow = {
  id: string; delivery_id: string | null; kind: string | null; severity: string | null
  rule: string | null; entity_id: string | null; source_locator: string | null; created_at: string | null
}
export type EpisodeRow = {
  id: string; source: string | null; job_id: string | null; error_class: string | null
  opened_at: string | null; recovered_at: string | null
}
export type Producer = { pending: number | null; held: number | null; countsCapped: boolean; lastRunAt: string | null }
export type EventsPage<T> = { rows: T[]; hasMore: boolean; nextCursor: EventCursor | null; availability: string | null; producer: Producer | null }

export const EVENT_PAGE_SIZE = 25
export const PRODUCER_UNAVAILABLE = 'producer_unavailable'
export const PRODUCER_ACTIVE = 'producer_active'

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value : null

const count = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
// Descriptive only: a malformed producer object is dropped, never an error and never a clean signal.
export function parseProducer(raw: unknown): Producer | null {
  if (!isObject(raw)) return null
  return { pending: count(raw.pending), held: count(raw.held), countsCapped: raw.counts_capped === true, lastRunAt: text(raw.last_run_at) }
}

function page<T>(raw: unknown, list: 'events' | 'episodes', version: 'semantics_version' | 'version', row: (item: Record<string, unknown>) => T | null): EventsPage<T> | null {
  if (!isObject(raw) || raw[version] !== 1 || !Array.isArray(raw[list]) || typeof raw.has_more !== 'boolean') return null
  const rows: T[] = []
  for (const item of raw[list] as unknown[]) {
    const parsed = isObject(item) ? row(item) : null
    if (!parsed) return null
    rows.push(parsed)
  }
  let nextCursor: EventCursor | null = null
  if (raw.has_more) {
    const cursor = raw.next_cursor
    if (!isObject(cursor) || !text(cursor.before) || !text(cursor.before_id)) return null
    nextCursor = { before: cursor.before as string, before_id: cursor.before_id as string }
  } else if (raw.next_cursor !== null && raw.next_cursor !== undefined) return null
  return { rows, hasMore: raw.has_more, nextCursor, availability: text(raw.availability), producer: parseProducer(raw.producer) }
}

export const parseEventsPage = (raw: unknown) => page<EventRow>(raw, 'events', 'semantics_version', item => {
  const id = text(item.id)
  return id ? { id, delivery_id: text(item.delivery_id), kind: text(item.kind), severity: text(item.severity), rule: text(item.rule), entity_id: text(item.entity_id), source_locator: text(item.source_locator), created_at: text(item.created_at) } : null
})

export const parseEpisodesPage = (raw: unknown) => page<EpisodeRow>(raw, 'episodes', 'version', item => {
  const id = text(item.id)
  return id ? { id, source: text(item.source), job_id: text(item.job_id), error_class: text(item.error_class), opened_at: text(item.opened_at), recovered_at: text(item.recovered_at) } : null
})

export type Notice = { tone: 'notice' | 'status'; text: string }

// Availability is shown whether or not rows exist: it describes the producer,
// not the history. Only producer_active lets an empty list mean "no events";
// every other value, including an unrecognised one, is never a clean result.
const PRODUCER_TEXT: Record<string, string> = {
  producer_unavailable: 'Alert production is not active yet.',
  producer_not_enqueuing: 'Alert production is on but not queueing new events.',
  producer_starting: 'Alert production is starting and has not run yet.',
  producer_stale: 'Alert production has not run for at least 5 minutes.',
  producer_degraded: 'Alert production is running with errors or delays.',
}

export function availabilityNotice(availability: string | null, rowCount: number, noun: 'events' | 'episodes', producer: Producer | null = null): Notice {
  if (availability === PRODUCER_ACTIVE) return { tone: 'status', text: `Alert production is active. ${rowCount ? `Showing stored ${noun}.` : `An empty list means no ${noun} are stored.`}` }
  if (availability === null) return { tone: 'notice', text: `Producer availability was not reported, so an empty list of ${noun} cannot be read as a clean result.` }
  const known = PRODUCER_TEXT[availability]
  const lead = known ?? `Producer availability is "${availability.replaceAll('_', ' ')}", which this page does not recognise.`
  const queue = producer && producer.pending !== null && producer.held !== null && (producer.pending || producer.held)
    ? ` ${producer.countsCapped ? 'At least ' : ''}${producer.pending} pending and ${producer.held} held for this site.` : ''
  const tail = rowCount
    ? `These stored ${noun} may be missing or delayed.`
    : `An empty list of ${noun} is not a clean result and does not mean the site has no new or regressed issues.`
  return { tone: 'notice', text: `${lead} ${tail}${queue}` }
}

export function emptyText(noun: 'events' | 'episodes'): string {
  return noun === 'events' ? 'No audit events are stored for this website.' : 'No provider failure episodes are stored for this website.'
}

export function episodeState(row: EpisodeRow): 'open' | 'recovered' | 'unknown' {
  if (row.recovered_at) return 'recovered'
  return row.opened_at ? 'open' : 'unknown'
}

const KINDS = new Map([['new', 'New issue'], ['reopened', 'Reopened'], ['severity_increased', 'Severity increased']])
export const kindLabel = (kind: string | null): string => kind === null ? 'Unknown' : KINDS.get(kind) ?? kind.replaceAll('_', ' ')
export const unknownText = (value: string | null): string => value ?? 'Unknown'

// Newest first, then by id, exactly as the database orders the keyset.
export function nextEventsQuery(cursor: EventCursor | null): { p_limit: number; p_before?: string; p_before_id?: string } {
  return { p_limit: EVENT_PAGE_SIZE, ...(cursor ? { p_before: cursor.before, p_before_id: cursor.before_id } : {}) }
}
