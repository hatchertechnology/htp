// Durable per-owner workspace context (selected website + report range).
// Pure module: no Vue, no DOM, no storage access. The composable owns storage.
import { validDateRange } from './analytics'

export const WORKSPACE_CONTEXT_VERSION = 1

// Days in every preset. All presets are relative: recomputed on load.
export type RangePreset = 7 | 28 | 30 | 90

export type StoredRange =
  | { kind: 'preset'; days: RangePreset }
  | { kind: 'custom'; start: string; end: string }

export type StoredContext = {
  version: typeof WORKSPACE_CONTEXT_VERSION
  websiteId: string | null
  range: StoredRange | null
}

// Owner decision Q1: a user with nothing stored gets a rolling Last 30 days.
export const DEFAULT_RANGE: StoredRange = { kind: 'preset', days: 30 }

const PRESETS: readonly RangePreset[] = [7, 28, 30, 90]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function contextStorageKey(ownerId: string): string {
  if (typeof ownerId !== 'string' || !UUID.test(ownerId)) throw new Error('A workspace context needs an owner UUID.')
  return `htp:workspace:v1:${ownerId}`
}

function isPreset(value: unknown): value is RangePreset {
  return PRESETS.includes(value as RangePreset)
}

function parseRange(value: unknown): StoredRange | null {
  if (!isRecord(value)) return null
  if (value.kind === 'preset') return isPreset(value.days) ? { kind: 'preset', days: value.days } : null
  if (value.kind === 'custom' && typeof value.start === 'string' && typeof value.end === 'string' && DAY.test(value.start) && DAY.test(value.end) && validDateRange(value.start, value.end)) {
    return { kind: 'custom', start: value.start, end: value.end }
  }
  return null
}

// Never throws: bad JSON, an old version or an unexpected shape yields empty context.
export function parseStoredContext(raw: string | null): StoredContext {
  const empty: StoredContext = { version: WORKSPACE_CONTEXT_VERSION, websiteId: null, range: null }
  if (typeof raw !== 'string' || raw === '') return empty
  let value: unknown
  try { value = JSON.parse(raw) } catch { return empty }
  if (!isRecord(value) || value.version !== WORKSPACE_CONTEXT_VERSION) return empty
  const websiteId = typeof value.websiteId === 'string' && UUID.test(value.websiteId) ? value.websiteId : null
  return { version: WORKSPACE_CONTEXT_VERSION, websiteId, range: parseRange(value.range) }
}

export function serializeContext(ctx: StoredContext): string {
  return JSON.stringify({ version: WORKSPACE_CONTEXT_VERSION, websiteId: ctx.websiteId, range: ctx.range })
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

// Exactly `days` inclusive calendar days ending yesterday (UTC): today's GA data
// is partial, matching the presets that shipped before this change.
export function presetRange(days: RangePreset, now: Date): { start: string; end: string } {
  const end = utcDay(now.getTime() - 86400_000)
  const start = utcDay(Date.parse(`${end}T00:00:00Z`) - (days - 1) * 86400_000)
  return { start, end }
}

const DEFAULT_DAYS: RangePreset = (DEFAULT_RANGE as { kind: 'preset'; days: RangePreset }).days

export function resolveRange(range: StoredRange | null, now: Date): { start: string; end: string; preset: RangePreset | null } {
  if (range?.kind === 'custom') {
    if (validDateRange(range.start, range.end)) return { start: range.start, end: range.end, preset: null }
    return { ...presetRange(DEFAULT_DAYS, now), preset: DEFAULT_DAYS }
  }
  const days = range?.kind === 'preset' && isPreset(range.days) ? range.days : DEFAULT_DAYS
  return { ...presetRange(days, now), preset: days }
}

// A stored website ID is used only once it is known to belong to this owner's list.
export function resolveSelection(storedId: string | null, sites: ReadonlyArray<{ id: string }>): { id: string; overwrite: boolean } {
  if (storedId && sites.some(site => site.id === storedId)) return { id: storedId, overwrite: false }
  const first = sites[0]?.id ?? ''
  return { id: first, overwrite: storedId !== (first || null) }
}
