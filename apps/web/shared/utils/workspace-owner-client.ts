import { websiteApiOrigin } from './websites-client'

const REPOSITORY = /^\/api(\/websites\/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\/repository)(?:\/(history|issues))?$/

// Closed owner REST mappings used by the workspace. Query/body/response shapes
// match the Nitro proxies; the history alias also proxies to the base resource.
export function resolveWorkspaceOwnerPath(path: string, method: unknown, staticDashboard: boolean, apiBaseUrl: unknown): string {
  if (!staticDashboard) return path
  if (method === 'GET' && /^\/api\/websites(?:\?(?:limit|offset)=\d+(?:&(?:limit|offset)=\d+)*)?$/.test(path)) {
    return `${websiteApiOrigin(apiBaseUrl)}${path.slice(4)}`
  }
  const match = REPOSITORY.exec(path)
  if (!match || !(method === 'GET' || (method === 'PUT' && !match[2]))) return path
  return `${websiteApiOrigin(apiBaseUrl)}${match[1]}${match[2] === 'issues' ? '/issues' : ''}`
}
