import { websiteApiOrigin } from './websites-client'

const PROPERTY = /^\/api(\/websites\/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\/analytics\/property)$/

const REPORT = /^\/api(\/websites\/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\/(?:analytics\/dashboard|bing\/dashboard|insights\/(?:report|history)|business\/location))$/

const REPOSITORY = /^\/api(\/websites\/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\/repository)(?:\/(history|issues))?$/

// Closed owner REST mappings used by the workspace. Query/body/response shapes
// match the Nitro proxies; the history alias also proxies to the base resource.
export function resolveWorkspaceOwnerPath(path: string, method: unknown, staticDashboard: boolean, apiBaseUrl: unknown): string {
  if (!staticDashboard) return path
  if (method === 'GET' && /^\/api\/websites(?:\?(?:limit|offset)=\d+(?:&(?:limit|offset)=\d+)*)?$/.test(path)) {
    return `${websiteApiOrigin(apiBaseUrl)}${path.slice(4)}`
  }
  const report = REPORT.exec(path)
  if (report && method === (path.endsWith('/business/location') ? 'PUT' : 'POST')) {
    return `${websiteApiOrigin(apiBaseUrl)}${report[1]}`
  }
  const property = PROPERTY.exec(path)
  if (property && method === 'PUT') return `${websiteApiOrigin(apiBaseUrl)}${property[1]}`
  const match = REPOSITORY.exec(path)
  if (!match || !(method === 'GET' || (method === 'PUT' && !match[2]))) return path
  return `${websiteApiOrigin(apiBaseUrl)}${match[1]}${match[2] === 'issues' ? '/issues' : ''}`
}

// Match Nitro's binding contract before REST can interpret null/omission as clear.
export function workspaceOwnerBody(path: string, method: unknown, staticDashboard: boolean, body: unknown): unknown {
  if (!staticDashboard || method !== 'PUT' || !PROPERTY.test(path)) return body
  const property = (body as { property_id?: unknown } | null)?.property_id
  if (typeof property !== 'string' || !/^[1-9][0-9]{0,19}$/.test(property)) {
    throw Object.assign(new Error('Enter a numeric GA4 property ID.'), { statusCode: 400 })
  }
  return { property_id: property }
}
