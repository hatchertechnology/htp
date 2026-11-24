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

type Report = { schema_version?: number; engine_version?: string; ruleset_version?: string; outcome?: string; coverage_complete?: boolean; stop_reason?: string | null; pages?: Array<{url: string; status?: number; content_type?: string; error?: unknown; extraction_truncated?: boolean; is_resource?: boolean; blocked_by_robots?: boolean; flags?: string[]}>; findings?: Array<{url: string; rule: string}> }
/** Only the controlled unmodified S15 engine assertion permits negative observations. */
export const CURRENT_SEMANTICS = 's15-metadata-1'
export type ComparisonCategory = 'agreement' | 'independent_only' | 'seosmith_only' | 'unknown' | 'unmapped'
export type ComparisonRow = Observation & { seosmith: Observation['state']; category: ComparisonCategory }
export function compareIndependent(rows: Observation[], report: Report, assertedUnmodified: boolean, semantics: string = CURRENT_SEMANTICS): ComparisonRow[] {
  switch (semantics) {
    case 's15-metadata-1': return compareS15Metadata1(rows, report, assertedUnmodified)
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
