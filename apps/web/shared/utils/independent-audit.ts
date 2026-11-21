/** S15 controlled-csv-v1: an explicit observation, never inferred from missing rows. */
export type Observation = { url: string; rule: string; state: 'present' | 'absent' | 'unknown' }
const mappedRules = new Set(['missing_title', 'missing_description'])

export function parseControlledCsv(source: string): Observation[] {
  if (new TextEncoder().encode(source).length > 4_194_304) throw new Error('Import exceeds 4 MiB.')
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false
  source = source.replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') { quoted = false; closed = true }
      else field += c
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field); field = ''; closed = false
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && source[i + 1] === '\n') i++ }
    } else if (c === '"' && !field && !closed) quoted = true
    else if (c === '"' || closed) throw new Error('Malformed CSV.')
    else field += c
  }
  if (quoted) throw new Error('Malformed CSV.')
  if (field || row.length || closed) { row.push(field); rows.push(row) }
  const header = rows.shift()
  if (!header || header.length !== 3 || header[0] !== 'url' || header[1] !== 'rule' || header[2] !== 'state') throw new Error('CSV columns must be url,rule,state.')
  const seen = new Set<string>()
  return rows.map(values => {
    const [url, rule, state] = values
    if (values.length !== 3 || !url || !rule || !['present', 'absent', 'unknown'].includes(state || '')) throw new Error('Invalid observation.')
    const key = JSON.stringify([url, rule]); if (seen.has(key)) throw new Error('Duplicate observation.'); seen.add(key)
    return { url, rule, state: state as Observation['state'] }
  })
}

type Report = { schema_version?: number; engine_version?: string; ruleset_version?: string; outcome?: string; coverage_complete?: boolean; pages?: Array<{url: string; status?: number; content_type?: string; error?: unknown; extraction_truncated?: boolean}>; findings?: Array<{url: string; rule: string}> }
/** Only the controlled unmodified S15 engine assertion permits negative observations. */
export function compareIndependent(rows: Observation[], report: Report, assertedUnmodified: boolean) {
  const compatible = assertedUnmodified && report.schema_version === 1 && report.engine_version === '0.2.0' && report.ruleset_version === '2026-11-01.1' && report.outcome === 'completed' && report.coverage_complete === true && Array.isArray(report.pages) && Array.isArray(report.findings)
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
    const eligible = compatible && mappedRules.has(row.rule) && !!page && !duplicatePages.has(row.url) && !page.error && page.extraction_truncated === false && typeof page.status === 'number' && page.status >= 200 && page.status < 300 && ['text/html', 'application/xhtml+xml', 'application/vnd.wap.xhtml+xml'].includes((page.content_type || '').split(';')[0]!.trim().toLowerCase())
    const seosmith = eligible ? (findings.has(JSON.stringify([row.url, row.rule])) ? 'present' : 'absent') : 'unknown'
    const category = !mappedRules.has(row.rule) ? 'unmapped' : row.state === 'unknown' || seosmith === 'unknown' ? 'unknown' : row.state === seosmith ? 'agreement' : row.state === 'present' ? 'independent_only' : 'seosmith_only'
    return { ...row, seosmith, category }
  })
}
