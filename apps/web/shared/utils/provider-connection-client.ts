import { websiteApiOrigin } from './websites-client'

// Only owner connection status and explicit disconnect use the REST API.
// OAuth start/callback and all other workspace requests retain their Nitro paths.
export function resolveProviderConnectionPath(path: string, method: unknown, staticDashboard: boolean, apiBaseUrl: unknown): string {
  if (!staticDashboard || (method !== 'GET' && method !== 'DELETE')) return path
  const match = /^\/api\/(google|bing)\/connection$/.exec(path)
  return match ? `${websiteApiOrigin(apiBaseUrl)}/providers/${match[1]}/connection` : path
}
