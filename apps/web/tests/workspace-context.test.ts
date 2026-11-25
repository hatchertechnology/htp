import { expect, it } from 'vitest'
import {
  DEFAULT_RANGE, WORKSPACE_CONTEXT_VERSION, contextStorageKey, parseStoredContext, presetRange, resolveRange, resolveSelection, serializeContext,
} from '../shared/utils/workspace-context'

const A = '00000000-0000-0000-0000-00000000000a'
const SITE = '00000000-0000-0000-0000-000000000001'
const OTHER = '00000000-0000-0000-0000-000000000002'

it('builds a per-owner storage key and rejects a non-UUID owner', () => {
  expect(contextStorageKey(A)).toBe(`htp:workspace:v1:${A}`)
  for (const value of ['', 'owner', A.replaceAll('-', ''), ` ${A}`, null, 7]) expect(() => contextStorageKey(value as unknown as string)).toThrow()
})

it('parses nothing, garbage and old versions into empty context', () => {
  const empty = { version: 1, websiteId: null, range: null }
  for (const raw of [null, '', 'not json', '[]', 'null', '7', JSON.stringify({ version: 2, websiteId: SITE }), JSON.stringify({ websiteId: SITE }), JSON.stringify({ version: 1, websiteId: 'nope', range: 'x' })]) {
    expect(parseStoredContext(raw as string | null)).toEqual(empty)
  }
})

it('allow-lists the stored shape', () => {
  expect(parseStoredContext(JSON.stringify({ version: WORKSPACE_CONTEXT_VERSION, websiteId: SITE, range: { kind: 'preset', days: 30 } })))
    .toEqual({ version: 1, websiteId: SITE, range: { kind: 'preset', days: 30 } })
  expect(parseStoredContext(JSON.stringify({ version: 1, websiteId: OTHER, range: { kind: 'custom', start: '2026-10-01', end: '2026-10-10' } })))
    .toEqual({ version: 1, websiteId: OTHER, range: { kind: 'custom', start: '2026-10-01', end: '2026-10-10' } })
  for (const range of [
    { kind: 'preset', days: 31 }, { kind: 'preset', days: 0 }, { kind: 'preset', days: '30' }, { kind: 'preset' },
    { kind: 'custom', start: '2026-10-10', end: '2026-10-01' }, { kind: 'custom', start: '2025-01-01', end: '2026-11-01' },
    { kind: 'custom', start: '2026-1-01', end: '2026-10-10' }, { kind: 'custom', start: '2026-10-01' }, { kind: 'other' },
  ]) expect(parseStoredContext(JSON.stringify({ version: 1, websiteId: null, range })).range).toBeNull()
  expect(parseStoredContext(JSON.stringify({ version: 1, websiteId: 7, range: null })).websiteId).toBeNull()
})

it('round-trips a stored context', () => {
  const context = { version: 1 as const, websiteId: SITE, range: { kind: 'preset' as const, days: 90 as const } }
  expect(parseStoredContext(serializeContext(context))).toEqual(context)
})

it('presets end yesterday and cover exactly `days` inclusive UTC days', () => {
  expect(presetRange(30, new Date('2026-11-25T00:30:00Z'))).toEqual({ start: '2026-10-26', end: '2026-11-24' })
  expect(presetRange(30, new Date('2026-11-25T23:59:59Z'))).toEqual({ start: '2026-10-26', end: '2026-11-24' })
  expect(presetRange(30, new Date('2026-11-26T00:30:00Z'))).toEqual({ start: '2026-10-27', end: '2026-11-25' })
  expect(presetRange(7, new Date('2026-11-25T12:00:00Z'))).toEqual({ start: '2026-11-18', end: '2026-11-24' })
  expect(presetRange(28, new Date('2026-11-25T12:00:00Z'))).toEqual({ start: '2026-10-28', end: '2026-11-24' })
  expect(presetRange(90, new Date('2026-11-25T12:00:00Z'))).toEqual({ start: '2026-08-27', end: '2026-11-24' })
})

it('resolves a stored range, falling back to rolling Last 30 days', () => {
  const now = new Date('2026-11-25T12:00:00Z')
  expect(resolveRange(null, now)).toEqual({ start: '2026-10-26', end: '2026-11-24', preset: 30 })
  expect(resolveRange({ kind: 'preset', days: 7 }, now)).toEqual({ start: '2026-11-18', end: '2026-11-24', preset: 7 })
  expect(resolveRange({ kind: 'custom', start: '2026-10-01', end: '2026-10-10' }, now)).toEqual({ start: '2026-10-01', end: '2026-10-10', preset: null })
  expect(resolveRange({ kind: 'custom', start: '2026-10-10', end: '2026-10-01' }, now)).toEqual({ start: '2026-10-26', end: '2026-11-24', preset: 30 })
  expect(resolveRange({ kind: 'preset', days: 31 as unknown as 30 }, now)).toEqual({ start: '2026-10-26', end: '2026-11-24', preset: 30 })
  expect(DEFAULT_RANGE).toEqual({ kind: 'preset', days: 30 })
})

it('selects a stored site only when it belongs to the owner list', () => {
  const sites = [{ id: SITE }, { id: OTHER }]
  expect(resolveSelection(SITE, sites)).toEqual({ id: SITE, overwrite: false })
  expect(resolveSelection(OTHER, sites)).toEqual({ id: OTHER, overwrite: false })
  const stale = '00000000-0000-0000-0000-0000000000ff'
  expect(resolveSelection(stale, sites)).toEqual({ id: SITE, overwrite: true })
  expect(resolveSelection(null, sites)).toEqual({ id: SITE, overwrite: true })
  expect(resolveSelection(null, [])).toEqual({ id: '', overwrite: false })
  expect(resolveSelection(stale, [])).toEqual({ id: '', overwrite: true })
})
