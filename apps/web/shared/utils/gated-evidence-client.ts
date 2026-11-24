import { websiteApiOrigin } from './websites-client'

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const PATH = new RegExp(`^/api/websites/${UUID}/(?:search/(dataset|crawl-evidence)|seo/audits/(lifecycle|url-lifecycle)|seo/audits/${UUID}/(work)|seo/work/${UUID}/(attempts))$`, 'i')
type Runtime = { staticDashboard?: boolean; apiBaseUrl?: unknown; rolloutSearchEvidence?: boolean; rolloutLifecycle?: boolean; rolloutRemediation?: boolean }

// Only routes already protected by the authoritative Rust rollout middleware.
// Keep Nitro's query projection and deadlines; bodies and responses pass through.
export function gatedEvidenceTransport(path: string, options: Record<string, unknown>, runtime: Runtime) {
  if (runtime.staticDashboard !== true) return { path, options }
  const match = PATH.exec(path)
  if (!match || match[0] !== path) return { path, options }
  const search = !!match[1], lifecycle = !!match[2], work = !!match[3]
  const method = options.method ?? 'GET'
  if (!(search ? method === 'POST' : lifecycle ? method === 'GET' : work ? method === 'GET' || method === 'POST' : method === 'POST')) {
    throw new Error('Unsupported evidence request method.')
  }
  const enabled = search ? runtime.rolloutSearchEvidence : lifecycle ? runtime.rolloutLifecycle : runtime.rolloutRemediation
  if (enabled !== true) throw Object.assign(new Error(search ? 'Search evidence is not available yet.' : lifecycle ? 'Indexed history is not available yet.' : 'Remediation is not available yet.'), { statusCode: 503 })
  const query = (options.query ?? {}) as Record<string, unknown>
  const keys = lifecycle ? ['entity_id', ...(match[2] === 'lifecycle' ? ['rule'] : []), 'limit', 'before', 'before_id'] : ['finding_index', 'before', 'before_id']
  const projected = Object.fromEntries(keys.map(key => [key, key === 'limit' ? query[key] ?? 50 : query[key]]))
  return {
    path: `${websiteApiOrigin(runtime.apiBaseUrl)}${path.slice(4)}`,
    options: { ...options, query: lifecycle || (work && method === 'GET') ? projected : undefined, timeout: search ? 35_000 : 30_000, redirect: 'error' },
  }
}
