/** S15 controlled-csv-v1: an explicit observation, never inferred from missing rows. */
export type Observation = { url: string; rule: string; state: 'present' | 'absent' | 'unknown' }
const mappedRules = new Set(['missing_title', 'missing_description'])

/**
 * User-supplied source metadata recorded with an import. The producing tool is
 * not authenticated; a missing field stays explicitly unknown rather than being
 * inferred. Keep the original file as the authoritative evidence.
 */
export const PROVENANCE_FIELDS = [
  { key: 'tool', label: 'Independent tool', placeholder: 'e.g. standalone desktop crawler' },
  { key: 'version', label: 'Tool version', placeholder: 'e.g. 9.4 (build 2026-11-01)' },
  { key: 'configuration', label: 'Configuration', placeholder: 'Preset, user agent, rendering, authentication and thresholds' },
  { key: 'scope', label: 'Scope', placeholder: 'Included hosts, paths, exclusions and discovery mode' },
  { key: 'exported_at', label: 'Exported at', placeholder: 'RFC 3339 timestamp when known' },
  { key: 'rule_definition', label: 'Rule definition and mapping', placeholder: 'How the tool rules correspond to url,rule,state' },
  { key: 'notes', label: 'Notes and limitations', placeholder: 'Known parser, fetch, rendering or rule differences' },
] as const
export type ProvenanceKey = typeof PROVENANCE_FIELDS[number]['key']
export type Provenance = Partial<Record<ProvenanceKey, string>>
export const PROVENANCE_MAX_BYTES = 60_000

/** Trim supplied provenance, drop empty fields, and bound it to the receiver's metadata limit. */
export function normalizeProvenance(input: Partial<Record<string, string | null | undefined>>): Provenance {
  const result: Provenance = {}
  for (const { key } of PROVENANCE_FIELDS) {
    const value = input[key]?.trim()
    if (value) result[key] = value
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > PROVENANCE_MAX_BYTES) throw new Error('Provenance metadata exceeds the 60 KiB limit.')
  return result
}

export type ProvenanceEntry = { key: string; label: string; placeholder: string; value: string | null }

/**
 * Render stored provenance with explicit unknown values, never silent keys.
 * Imports saved before structured metadata was introduced may carry a free-text
 * string; keep that text visible as a legacy note rather than hiding it.
 */
export function provenanceEntries(provenance: unknown): ProvenanceEntry[] {
  const legacy = typeof provenance === 'string' ? provenance.trim() : ''
  const value = provenance && typeof provenance === 'object' ? provenance as Record<string, unknown> : {}
  const entries: ProvenanceEntry[] = PROVENANCE_FIELDS.map(field => ({
    key: field.key,
    label: field.label,
    placeholder: field.placeholder,
    value: typeof value[field.key] === 'string' && (value[field.key] as string).trim() ? (value[field.key] as string) : null,
  }))
  if (legacy) entries.push({ key: 'legacy', label: 'Legacy source note', placeholder: '', value: legacy })
  return entries
}

/** Count every disagreement and unknown category so the UI never hides unsupported rows. */
export function summarizeComparison(rows: Array<{ category: ComparisonCategory }>) {
  const summary: Record<ComparisonCategory, number> & { total: number } = { agreement: 0, independent_only: 0, seosmith_only: 0, unknown: 0, unmapped: 0, total: rows.length }
  for (const row of rows) summary[row.category]++
  return summary
}

export function sourceByteLength(source: string): number { return new TextEncoder().encode(source).length }

export function parseControlledCsv(source: string): Observation[] {
  if (new TextEncoder().encode(source).length > 4_194_304) throw new Error('Import exceeds 4 MiB.')
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false, fieldStart = 0
  source = source.replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') { quoted = false; closed = true }
      else field += c
    } else if (c === ',' || c === '\n' || c === '\r') {
      if (new TextEncoder().encode(source.slice(fieldStart, i)).length > 8192) throw new Error('CSV field exceeds 8,192 bytes.')
      row.push(field); field = ''; closed = false
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && source[i + 1] === '\n') i++ }
      fieldStart = i + 1
    } else if (c === '"' && !field && !closed) quoted = true
    else if (c === '"' || closed) throw new Error('Malformed CSV.')
    else field += c
  }
  if (quoted) throw new Error('Malformed CSV.')
  if (field || row.length || closed) { if (new TextEncoder().encode(source.slice(fieldStart)).length > 8192) throw new Error('CSV field exceeds 8,192 bytes.'); row.push(field); rows.push(row) }
  if (rows.length > 2001) throw new Error('CSV exceeds 2,000 observations.')
  const header = rows.shift()
  if (!header || header.length !== 3 || header[0] !== 'url' || header[1] !== 'rule' || header[2] !== 'state') throw new Error('CSV columns must be url,rule,state.')
  const seen = new Set<string>(); let keyBytes = 0
  return rows.map(values => {
    const [url, rule, state] = values
    if (values.length !== 3 || !url || !rule || !['present', 'absent', 'unknown'].includes(state || '')) throw new Error('Invalid observation.')
    keyBytes += new TextEncoder().encode(url).length + new TextEncoder().encode(rule).length
    if (keyBytes > 262144) throw new Error('CSV URL and rule keys exceed 256 KiB.')
    const key = JSON.stringify([url, rule]); if (seen.has(key)) throw new Error('Duplicate observation.'); seen.add(key)
    return { url, rule, state: state as Observation['state'] }
  })
}

type Evaluation = { entity_id?: string; rule?: string; outcome?: string; unknown_reason?: string | null }
type Coverage = { rule?: string; unknown?: number; unknown_reasons?: Record<string, number> }
type EvidenceContract = { version?: number; truncated?: boolean; evaluation_coverage_complete?: boolean; evaluations?: Evaluation[]; coverage?: Coverage[] }
type Report = { schema_version?: number; engine_version?: string; ruleset_version?: string; outcome?: string; coverage_complete?: boolean; stop_reason?: string | null; pages?: Array<{url: string; status?: number; content_type?: string; error?: unknown; extraction_truncated?: boolean; is_resource?: boolean; blocked_by_robots?: boolean; flags?: string[]}>; findings?: Array<{url: string; rule: string}>; evidence_contract?: EvidenceContract }
/** Newest semantics, used for new comparisons. Older supported versions stay replayable. */
export const CURRENT_SEMANTICS = 's15-metadata-2'
export const SUPPORTED_SEMANTICS = ['s15-metadata-1', 's15-metadata-2'] as const
export function isSupportedSemantics(semantics: string): boolean { return (SUPPORTED_SEMANTICS as readonly string[]).includes(semantics) }
export type ComparisonCategory = 'agreement' | 'independent_only' | 'seosmith_only' | 'unknown' | 'unmapped'
/** `reason` and `reason_count` explain an `unknown` SEOsmith observation for s15-metadata-2 rows; they are absent for s15-metadata-1. */
export type ComparisonRow = Observation & { seosmith: Observation['state']; category: ComparisonCategory; reason?: string; reason_count?: number }
export function compareIndependent(rows: Observation[], report: Report, assertedUnmodified: boolean, semantics: string = CURRENT_SEMANTICS): ComparisonRow[] {
  switch (semantics) {
    case 's15-metadata-1': return compareS15Metadata1(rows, report, assertedUnmodified)
    case 's15-metadata-2': return compareS15Metadata2(rows, report, assertedUnmodified)
    default: throw new Error(`Unsupported comparison semantics: ${semantics}`)
  }
}

// Frozen implementation: add a new version rather than changing this after release.
function compareS15Metadata1(rows: Observation[], report: Report, assertedUnmodified: boolean): ComparisonRow[] {
  const compatible = assertedUnmodified && report.schema_version === 1 && report.engine_version === '0.2.0' && report.ruleset_version === '2026-11-01.1' && report.outcome === 'completed' && report.stop_reason === 'frontier_exhausted' && report.coverage_complete === true && Array.isArray(report.pages) && Array.isArray(report.findings)
  const pages = new Map<string, NonNullable<Report['pages']>[number]>()
  const duplicatePages = new Set<string>()
  for (const page of report.pages || []) { if (pages.has(page.url)) duplicatePages.add(page.url); pages.set(page.url, page) }
  const findings = new Set((report.findings || []).map(f => JSON.stringify([f.url, f.rule])))
  const known = new Set(rows.map(row => JSON.stringify([row.url, row.rule])))
  const combined = [...rows]
  for (const finding of report.findings || []) {
    const key = JSON.stringify([finding.url, finding.rule])
    if (!known.has(key)) { combined.push({ url: finding.url, rule: finding.rule, state: 'unknown' }); known.add(key) }
  }
  return combined.map(row => {
    const page = pages.get(row.url)
    const eligible = compatible && mappedRules.has(row.rule) && !!page && !duplicatePages.has(row.url) && !page.error && page.is_resource === false && page.blocked_by_robots === false && Array.isArray(page.flags) && !page.flags.some(flag => ['extraction_limit', 'discovery_limit', 'legacy_checkpoint_metadata'].includes(flag)) && page.extraction_truncated === false && typeof page.status === 'number' && page.status >= 200 && page.status < 300 && ['text/html', 'application/xhtml+xml', 'application/vnd.wap.xhtml+xml'].includes((page.content_type || '').split(';')[0]!.trim().toLowerCase())
    const seosmith = eligible ? (findings.has(JSON.stringify([row.url, row.rule])) ? 'present' : 'absent') : 'unknown'
    const category: ComparisonCategory = !mappedRules.has(row.rule) ? 'unmapped' : row.state === 'unknown' || seosmith === 'unknown' ? 'unknown' : row.state === seosmith ? 'agreement' : row.state === 'present' ? 'independent_only' : 'seosmith_only'
    return { ...row, seosmith, category }
  })
}

const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2])
/** Synchronous SHA-256 (hex) so the frozen comparison stays a pure, synchronous function. */
export function sha256Hex(input: string): string {
  const data = new TextEncoder().encode(input), bits = data.length * 8
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6)
  padded.set(data); padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000)); view.setUint32(padded.length - 4, bits >>> 0)
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3), s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[]
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) | 0
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) | 0
      hh = g; g = f; f = e; e = (d! + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h[0] = (h[0]! + a!) | 0; h[1] = (h[1]! + b!) | 0; h[2] = (h[2]! + c!) | 0; h[3] = (h[3]! + d!) | 0
    h[4] = (h[4]! + e!) | 0; h[5] = (h[5]! + f!) | 0; h[6] = (h[6]! + g!) | 0; h[7] = (h[7]! + hh!) | 0
  }
  return [...h].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

/** SEOsmith `entity_id` for a page: the URL is hashed exactly as the report spells it (no normalization). */
export function pageEntityId(url: string): string { return `sha256:${sha256Hex(`seosmith-entity-v1\npage\n${url}`)}` }

// Frozen implementation: add a new version rather than changing this after release.
// Schema 4 reports. Matching is by SEOsmith entity_id; `evaluation_coverage_complete` is deliberately NOT a gate
// (it is false in every real report). A row is `present` for a `fail` evaluation, `absent` for a `pass` evaluation of
// `missing_title` whose rule has no unknown coverage, and `unknown` otherwise. `missing_description` is never `absent`.
function compareS15Metadata2(rows: Observation[], report: Report, assertedUnmodified: boolean): ComparisonRow[] {
  const contract = report.evidence_contract
  const compatible = assertedUnmodified && report.schema_version === 4 && report.outcome === 'completed' && report.coverage_complete === true
    && !!contract && contract.version === 1 && contract.truncated === false && Array.isArray(contract.evaluations) && Array.isArray(contract.coverage)
  const evaluations = new Map<string, Evaluation>(), duplicates = new Set<string>()
  const coverage = new Map<string, Coverage>(), duplicateCoverage = new Set<string>()
  if (compatible) {
    for (const e of contract!.evaluations!) { const key = JSON.stringify([e.entity_id, e.rule]); if (evaluations.has(key)) duplicates.add(key); evaluations.set(key, e) }
    for (const c of contract!.coverage!) { if (coverage.has(c.rule!)) duplicateCoverage.add(c.rule!); coverage.set(c.rule!, c) }
  }
  const known = new Set(rows.map(row => JSON.stringify([row.url, row.rule])))
  const combined = [...rows]
  for (const finding of report.findings || []) {
    const key = JSON.stringify([finding.url, finding.rule])
    if (!known.has(key)) { combined.push({ url: finding.url, rule: finding.rule, state: 'unknown' }); known.add(key) }
  }
  // Largest count first, then key order, so the explanation is deterministic.
  const topReason = (rule: string): { reason: string; count: number } | null => {
    const entries = Object.entries(coverage.get(rule)?.unknown_reasons || {}).filter(([, n]) => typeof n === 'number' && n > 0).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    return entries[0] ? { reason: entries[0][0], count: entries[0][1] } : null
  }
  const observe = (row: Observation): { state: Observation['state']; reason?: string; count?: number } => {
    if (!mappedRules.has(row.rule)) return { state: 'unknown' }
    if (!compatible) return { state: 'unknown', reason: 'report_not_comparable' }
    const cov = coverage.get(row.rule)
    if (!cov || duplicateCoverage.has(row.rule) || typeof cov.unknown !== 'number') return { state: 'unknown', reason: 'no_coverage' }
    const key = JSON.stringify([pageEntityId(row.url), row.rule])
    if (duplicates.has(key)) return { state: 'unknown', reason: 'duplicate_evaluation' }
    const evaluation = evaluations.get(key)
    if (!evaluation) { const top = topReason(row.rule); return top ? { state: 'unknown', reason: top.reason, count: top.count } : { state: 'unknown', reason: 'no_evaluation' } }
    if (evaluation.outcome === 'fail') return { state: 'present' }
    if (evaluation.outcome === 'pass') {
      if (row.rule !== 'missing_title') return { state: 'unknown', reason: 'absence_not_established' }
      if (cov.unknown === 0) return { state: 'absent' }
      const top = topReason(row.rule); return { state: 'unknown', reason: top?.reason ?? 'coverage_unknown', count: top?.count ?? cov.unknown }
    }
    if (evaluation.outcome === 'unknown') {
      const reason = evaluation.unknown_reason || topReason(row.rule)?.reason || 'unknown_outcome'
      return { state: 'unknown', reason, count: cov.unknown_reasons?.[reason] }
    }
    return { state: 'unknown', reason: evaluation.outcome || 'no_evaluation' }
  }
  return combined.map(row => {
    const seen = observe(row), seosmith = seen.state
    const category: ComparisonCategory = !mappedRules.has(row.rule) ? 'unmapped' : row.state === 'unknown' || seosmith === 'unknown' ? 'unknown' : row.state === seosmith ? 'agreement' : row.state === 'present' ? 'independent_only' : 'seosmith_only'
    const result: ComparisonRow = { ...row, seosmith, category }
    if (seen.reason) { result.reason = seen.reason; if (seen.count !== undefined) result.reason_count = seen.count }
    return result
  })
}
