// Defensive validation of the s14-wire-2 `evidence_families` object (families-v1,
// design wave1-wp8a §3.1/§3.2). The producer constructs these invariants and the
// receiver checks them; the web panel checks them again and refuses what fails,
// so a malformed section is never rendered as data. `null` is never read as
// "absent": it is refused (see parseFamiliesEnvelope for the one legitimate
// not-collected shape).
//
// Not checkable here: that a locator resolves inside the same report and that an
// entity_id equals the S01 hash of its page (the panel does not hold the page
// list), and kind-table membership (the kind table ships with the SEOsmith
// contract doc). Those stay receiver-side; the panel checks shape only.

export const FAMILY_KEYS = ['s02_indexing', 's03_integrity', 's04_structured_data', 's05_link_graph', 's06_duplicates', 's08_resources'] as const
export type FamilyKey = typeof FAMILY_KEYS[number]
export type FamilyOutcome = 'issue' | 'pass' | 'observed' | 'unknown'
export type FamilySectionState = 'complete' | 'partial' | 'unavailable'
export type FamilyCoverage = { entities: number; eligible: number; attempted: number; observed: number; unknown: number; unknown_reasons: Record<string, number> }
export type FamilyItem = { entity_id: string | null; locator: string | null; kind: string; outcome: FamilyOutcome; reason: string | null; facts: Record<string, unknown> }
export type FamilySection = {
  section_version: 1; semantics: string; state: FamilySectionState; reason: string | null; coverage: FamilyCoverage
  summary: Record<string, unknown>; items: FamilyItem[]; items_total: number; omitted_items: number
  omitted_reason: string | null; truncated: boolean; max_items: number; max_bytes: number
}
export type EvidenceFamilies = {
  version: 1; semantics: 's14-families-1'; max_bytes: 786432; budget_state: 'within_budget' | 'report_byte_budget'
  families: Record<FamilyKey, FamilySection>
}
export type FamiliesValidation<T> = { ok: true; value: T } | { ok: false; error: string }

const TOTAL_MAX_BYTES = 786_432
// Binding per-family caps (design §3.3; receiver families.rs TABLE; producer types.rs). Exact equality, as the receiver requires.
export const FAMILY_CAPS: Record<FamilyKey, { maxItems: number; maxBytes: number }> = {
  s02_indexing: { maxItems: 256, maxBytes: 98_304 },
  s03_integrity: { maxItems: 256, maxBytes: 163_840 },
  s04_structured_data: { maxItems: 256, maxBytes: 131_072 },
  s05_link_graph: { maxItems: 256, maxBytes: 131_072 },
  s06_duplicates: { maxItems: 128, maxBytes: 98_304 },
  s08_resources: { maxItems: 256, maxBytes: 163_840 },
}
const SEMANTICS_MAX_BYTES = 64
const FACTS_MAX_BYTES = 4_096, FACTS_MAX_DEPTH = 4, STRING_MAX_BYTES = 2_048, SUMMARY_MAX_BYTES = 8_192
const CODE = /^[a-z0-9_]{1,64}$/
const LOCATOR = /^\/pages\/(?:0|[1-9]\d*)(?:\/(?:links|relationships)\/(?:0|[1-9]\d*))?$/
const OMITTED_REASONS = new Set(['family_item_limit', 'family_byte_budget', 'report_byte_budget', 'analysis_deadline'])
const CAPTURE_OMISSIONS = new Set(['collector_byte_limit', 'run_byte_limit'])
const RANK = new Map<string, number>([['issue', 0], ['unknown', 1], ['observed', 2], ['pass', 3]])
const encoder = new TextEncoder()

class Refusal extends Error {}
const refuse = (message: string): never => { throw new Refusal(message) }
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bytes = (v: string) => encoder.encode(v).length
const count = (v: unknown, name: string): number => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : refuse(`${name} must be a non-negative integer`)
const code = (v: unknown, name: string): string => typeof v === 'string' && CODE.test(v) ? v : refuse(`${name} is not a valid code`)
const nullableCode = (v: unknown, name: string) => v === null ? null : code(v, name)

function exactKeys(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null) return refuse(`${name} is null`)
  if (!isObject(value)) return refuse(`${name} must be an object`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) refuse(`${name} has an unknown key: ${key}`)
  for (const key of keys) if (!Object.hasOwn(value, key)) refuse(`${name} is missing ${key}`)
  return value
}

function checkJson(v: unknown, depth: number, name: string, maxDepth = FACTS_MAX_DEPTH) {
  if (typeof v === 'string') {
    if (v.includes('\u0000')) refuse(`${name} contains a NUL character`)
    if (bytes(v) > STRING_MAX_BYTES) refuse(`${name} has a string over ${STRING_MAX_BYTES} bytes`)
  } else if (Array.isArray(v) || isObject(v)) {
    if (depth > maxDepth) refuse(`${name} is nested deeper than ${maxDepth} levels (depth)`)
    for (const [key, child] of Array.isArray(v) ? v.entries() : Object.entries(v)) {
      if (typeof key === 'string') {
        if (key.includes('\u0000')) refuse(`${name} contains a NUL character`)
        if (bytes(key) > STRING_MAX_BYTES) refuse(`${name} has a key over ${STRING_MAX_BYTES} bytes`)
      }
      checkJson(child, depth + 1, name, maxDepth)
    }
  } else if (typeof v === 'number' && !Number.isFinite(v)) refuse(`${name} has a non-finite number`)
  else if (v !== null && typeof v !== 'number' && typeof v !== 'boolean') refuse(`${name} has an unsupported value`)
}

function coverageOf(raw: unknown, name: string): FamilyCoverage {
  const c = exactKeys(raw, ['entities', 'eligible', 'attempted', 'observed', 'unknown', 'unknown_reasons'], `${name}.coverage`)
  for (const key of ['entities', 'eligible', 'attempted', 'observed', 'unknown']) count(c[key], `${name}.coverage.${key}`)
  if (!isObject(c.unknown_reasons)) return refuse(`${name}.coverage.unknown_reasons must be an object`)
  let sum = 0
  for (const [key, n] of Object.entries(c.unknown_reasons)) { code(key, `${name}.coverage.unknown_reasons key`); sum += count(n, `${name}.coverage.unknown_reasons.${key}`) }
  if (sum !== c.unknown) refuse(`${name}.coverage.unknown_reasons sums to ${sum}, not unknown (${String(c.unknown)})`)
  return c as unknown as FamilyCoverage
}

function itemOf(raw: unknown, name: string): FamilyItem {
  const it = exactKeys(raw, ['entity_id', 'locator', 'kind', 'outcome', 'reason', 'facts'], name)
  code(it.kind, `${name}.kind`)
  if (typeof it.outcome !== 'string' || !RANK.has(it.outcome)) refuse(`${name}.outcome is not issue, pass, observed or unknown`)
  const reason = nullableCode(it.reason, `${name}.reason`)
  if (it.outcome === 'unknown' && reason === null) refuse(`${name} is unknown without a reason`)
  if (it.outcome === 'pass' && reason !== null && CAPTURE_OMISSIONS.has(reason)) refuse(`${name} is a capture omission reported as pass`)
  if (it.locator !== null && (typeof it.locator !== 'string' || !LOCATOR.test(it.locator))) refuse(`${name}.locator is not a /pages/N, /pages/N/links/M or /pages/N/relationships/M path`)
  if (typeof it.entity_id !== 'string' && it.entity_id !== null) refuse(`${name}.entity_id must be text or null`)
  if ((it.locator === null) !== (it.entity_id === null)) refuse(`${name}: entity_id and locator must both be set or both be null`)
  if (!isObject(it.facts)) return refuse(`${name}.facts must be an object`)
  checkJson(it.facts, 1, `${name}.facts`)
  if (bytes(JSON.stringify(it.facts)) > FACTS_MAX_BYTES) refuse(`${name}.facts is over ${FACTS_MAX_BYTES} bytes`)
  if (it.locator === null && (typeof it.facts.url !== 'string' || !it.facts.url)) refuse(`${name} has no page binding and no facts.url`)
  return it as unknown as FamilyItem
}

function sectionOf(raw: unknown, key: FamilyKey): FamilySection {
  const name: string = key
  const s = exactKeys(raw, ['section_version', 'semantics', 'state', 'reason', 'coverage', 'summary', 'items', 'items_total', 'omitted_items', 'omitted_reason', 'truncated', 'max_items', 'max_bytes'], name)
  if (s.section_version !== 1) refuse(`${name}.section_version must be 1`)
  if (typeof s.semantics !== 'string' || !s.semantics || bytes(s.semantics) > SEMANTICS_MAX_BYTES) refuse(`${name}.semantics is missing`)
  if (s.state !== 'complete' && s.state !== 'partial' && s.state !== 'unavailable') refuse(`${name}.state is not complete, partial or unavailable`)
  const reason = nullableCode(s.reason, `${name}.reason`)
  const coverage = coverageOf(s.coverage, name)
  if (!isObject(s.summary)) return refuse(`${name}.summary must be an object`)
  if (bytes(JSON.stringify(s.summary)) > SUMMARY_MAX_BYTES) refuse(`${name}.summary is over ${SUMMARY_MAX_BYTES} bytes`)
  checkJson(s.summary, 1, `${name}.summary`, Number.POSITIVE_INFINITY) // the receiver bounds summary bytes and strings, not depth
  if (!Array.isArray(s.items)) return refuse(`${name}.items must be a list`)
  const itemsTotal = count(s.items_total, `${name}.items_total`), omitted = count(s.omitted_items, `${name}.omitted_items`)
  const maxItems = count(s.max_items, `${name}.max_items`), maxBytes = count(s.max_bytes, `${name}.max_bytes`)
  const cap = FAMILY_CAPS[key]
  if (maxItems !== cap.maxItems) refuse(`${name}.max_items must be ${cap.maxItems}`)
  if (maxBytes !== cap.maxBytes) refuse(`${name}.max_bytes must be ${cap.maxBytes}`)
  if (s.items.length > maxItems) refuse(`${name}.items has more entries than max_items`)
  if (typeof s.truncated !== 'boolean') refuse(`${name}.truncated must be true or false`)
  if (itemsTotal !== s.items.length + omitted) refuse(`${name}.items_total (${itemsTotal}) is not items + omitted_items (${s.items.length + omitted})`)
  if (s.truncated !== (omitted > 0)) refuse(`${name}.truncated does not match omitted_items`)
  if (s.truncated) { if (typeof s.omitted_reason !== 'string' || !OMITTED_REASONS.has(s.omitted_reason)) refuse(`${name}.omitted_reason must name why items were omitted`) }
  else if (s.omitted_reason !== null) refuse(`${name}.omitted_reason is set but nothing was omitted`)
  if (s.state === 'complete' && (coverage.unknown !== 0 || s.truncated)) refuse(`${name} is complete but has unknown entities or omitted items`)
  if (s.state === 'unavailable' && (s.items.length > 0 || reason === null)) refuse(`${name} is unavailable but has items or no reason`)
  if (bytes(JSON.stringify(s)) > maxBytes) refuse(`${name} is larger than its max_bytes`)
  let previous: FamilyItem | null = null
  let unknownItems = 0
  s.items.forEach((entry, i) => {
    const item = itemOf(entry, `${name}.items[${i}]`)
    if (item.outcome === 'unknown') unknownItems++
    if (previous) {
      const a = RANK.get(previous.outcome)!, b = RANK.get(item.outcome)!
      const lp = previous.locator ?? '', li = item.locator ?? ''
      if (a > b || (a === b && (lp > li || (lp === li && previous.kind > item.kind)))) refuse(`${name}.items[${i}] is out of order (outcome, locator, kind)`)
    }
    previous = item
  })
  if (unknownItems > coverage.unknown) refuse(`${name} has ${unknownItems} unknown items but coverage.unknown is ${coverage.unknown}`)
  return s as unknown as FamilySection
}

export function validateEvidenceFamilies(raw: unknown): FamiliesValidation<EvidenceFamilies> {
  try {
    const top = exactKeys(raw, ['version', 'semantics', 'max_bytes', 'budget_state', 'families'], 'evidence_families')
    if (top.version !== 1) refuse('evidence_families.version must be 1')
    if (top.semantics !== 's14-families-1') refuse('evidence_families.semantics is not s14-families-1')
    if (top.max_bytes !== TOTAL_MAX_BYTES) refuse(`evidence_families.max_bytes must be ${TOTAL_MAX_BYTES}`)
    if (top.budget_state !== 'within_budget' && top.budget_state !== 'report_byte_budget') refuse('evidence_families.budget_state is not within_budget or report_byte_budget')
    const families = exactKeys(top.families, FAMILY_KEYS, 'evidence_families.families')
    for (const key of FAMILY_KEYS) sectionOf(families[key], key)
    if (bytes(JSON.stringify(raw)) > TOTAL_MAX_BYTES) refuse('evidence_families is over its byte cap')
    return { ok: true, value: raw as EvidenceFamilies }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.message }
    throw error
  }
}

export type FamiliesResult =
  | { kind: 'collected'; families: EvidenceFamilies; wireContractVersion: string | null }
  | { kind: 'not_collected'; wireContractVersion: string | null }
  | { kind: 'invalid'; message: string }

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

// The route's 200 body: {delivery_id, wire_contract_version, evidence_families, reason}.
// reason is null (families present) or "not_collected" (a v1 audit: families null).
export function parseFamiliesEnvelope(raw: unknown, deliveryId: string): FamiliesResult {
  try {
    const env = exactKeys(raw, ['delivery_id', 'wire_contract_version', 'evidence_families', 'reason'], 'response')
    if (typeof env.delivery_id !== 'string' || !UUID.test(env.delivery_id) || env.delivery_id.toLowerCase() !== deliveryId.toLowerCase()) refuse('response is for a different audit')
    if (env.wire_contract_version !== null && (typeof env.wire_contract_version !== 'string' || bytes(env.wire_contract_version) > 64)) refuse('response.wire_contract_version is not text')
    const wire = env.wire_contract_version as string | null
    if (env.reason === 'not_collected') {
      if (env.evidence_families !== null) refuse('response says not_collected but carries families')
      return { kind: 'not_collected', wireContractVersion: wire }
    }
    if (env.reason !== null) refuse('response.reason is not recognised')
    const checked = validateEvidenceFamilies(env.evidence_families)
    if (!checked.ok) return { kind: 'invalid', message: checked.error }
    return { kind: 'collected', families: checked.value, wireContractVersion: wire }
  } catch (error) {
    if (error instanceof Refusal) return { kind: 'invalid', message: error.message }
    throw error
  }
}

// ---- Presentation helpers (pure; the component only renders what these return) ----
// Rule: unknown is never shown as 0. An unavailable section has no meaningful
// counts, so none are shown; an unknown item says "Unknown" and why.

export const FAMILY_LABELS: Record<FamilyKey, string> = {
  s02_indexing: 'Indexing', s03_integrity: 'Integrity', s04_structured_data: 'Structured data',
  s05_link_graph: 'Link graph', s06_duplicates: 'Duplicates', s08_resources: 'Resources',
}

const REASONS: Record<string, string> = {
  collector_byte_limit: 'the collector reached its size limit',
  run_byte_limit: 'the crawl reached its size limit',
  contract_limit: 'a contract limit was reached',
  observation_limit: 'the observation limit was reached',
  record_limit: 'the record limit was reached',
  main_text_not_retained: 'page text was not retained',
  robots_unavailable: 'robots.txt could not be read',
  target_not_fetched: 'the target was not fetched',
  source_unavailable: 'the source was unavailable',
  robots_blocked: 'blocked by robots.txt',
  link_limit: 'the link limit was reached',
  referrer_limit: 'the referrer limit was reached',
  sitemap_lookup_limit: 'the sitemap lookup limit was reached',
  profile_unsupported: 'the crawl profile does not support this check',
  analysis_deadline: 'the analysis ran out of time',
  analyzer_row_limit: 'the analyzer row limit was reached',
  analyzer_error: 'the analyzer failed',
  capture_mode_changed: 'capture settings changed during the run',
  family_item_limit: 'the per-family item limit was reached',
  family_byte_budget: 'the per-family size budget was reached',
  report_byte_budget: 'the report size budget was reached',
}
export function familyReasonText(code: string | null | undefined): string {
  if (!code) return ''
  return Object.hasOwn(REASONS, code) ? REASONS[code]! : code.replace(/_/g, ' ')
}
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function familyFactsText(facts: Record<string, unknown>): string {
  return Object.keys(facts).sort().map((key) => {
    const v = facts[key]
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    return `${key}: ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`
  }).join(' · ')
}

export type PanelLoad = { kind: 'loading' } | FamiliesResult | { kind: 'flag_off' } | { kind: 'not_found' } | { kind: 'unavailable'; message: string }
export type FamiliesNotice = { tone: 'info' | 'notice' | 'error'; text: string }
export function panelNotice(load: PanelLoad): FamiliesNotice {
  switch (load.kind) {
    case 'loading': return { tone: 'info', text: 'Reading stored evidence families…' }
    case 'flag_off': return { tone: 'info', text: 'Per-family evidence is not available yet. No evidence is shown, and that does not mean the checks passed.' }
    case 'not_collected': return { tone: 'info', text: 'This audit was saved before per-family evidence existed, so these families were not collected. That does not mean the checks passed.' }
    case 'not_found': return { tone: 'notice', text: 'Per-family evidence for this audit was not found for your account.' }
    case 'unavailable': return { tone: 'error', text: load.message }
    case 'invalid': return { tone: 'error', text: `Evidence families were refused because the stored data is malformed: ${load.message}. Nothing is shown from it.` }
    case 'collected': return load.families.budget_state === 'report_byte_budget'
      ? { tone: 'notice', text: 'This report reached its size budget, so some family items were left out. Coverage counts are complete; the items left out are counted per family.' }
      : { tone: 'info', text: '' }
  }
}

export type FamilySectionView = {
  key: FamilyKey; label: string; stateLabel: string; notice: string | null; truncation: string | null
  counts: Array<{ label: string; value: string }>
  unknownReasons: Array<{ code: string; text: string; count: number }>
  rows: Array<{ locator: string; kind: string; outcome: string; reason: string; facts: string }>
}
const OUTCOME_LABEL: Record<FamilyOutcome, string> = { issue: 'Issue', pass: 'Pass', observed: 'Observed', unknown: 'Unknown' }

export function sectionView(key: FamilyKey, s: FamilySection): FamilySectionView {
  const stateLabel = sentence(s.state)
  const base = { key, label: FAMILY_LABELS[key], stateLabel }
  if (s.state === 'unavailable') {
    return { ...base, notice: `Not collected for this audit: ${familyReasonText(s.reason) || 'no reason was recorded'}. No counts are available, which is different from zero.`, truncation: null, counts: [], unknownReasons: [], rows: [] }
  }
  const c = s.coverage
  const counts = [['Entities', c.entities], ['Eligible', c.eligible], ['Attempted', c.attempted], ['Observed', c.observed], ['Unknown', c.unknown]] as const
  const unknownReasons = Object.entries(c.unknown_reasons).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([code, count]) => ({ code, text: familyReasonText(code), count }))
  const notice = s.state === 'partial'
    ? (c.unknown > 0 ? `${c.unknown.toLocaleString()} ${c.unknown === 1 ? 'entity' : 'entities'} could not be determined, so this family is partial. Missing items are not passes.` : 'This family is partial: some coverage is missing. Missing items are not passes.')
    : null
  const truncation = s.truncated
    ? `Showing ${s.items.length.toLocaleString()} of ${s.items_total.toLocaleString()} items; ${s.omitted_items.toLocaleString()} omitted because ${familyReasonText(s.omitted_reason)}.`
    : null
  const rows = s.items.map(i => ({
    locator: i.locator ?? (typeof i.facts.url === 'string' ? i.facts.url : 'Unknown'),
    kind: i.kind.replace(/_/g, ' '), outcome: Object.hasOwn(OUTCOME_LABEL, i.outcome) ? OUTCOME_LABEL[i.outcome] : 'Unknown', reason: sentence(familyReasonText(i.reason)), facts: familyFactsText(i.facts),
  }))
  return { ...base, notice, truncation, counts: counts.map(([label, n]) => ({ label, value: n.toLocaleString() })), unknownReasons, rows }
}
