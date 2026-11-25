import { websiteApiOrigin } from './websites-client'

// Exact provider paths only. Static Connect has its own receiver-first rollout gate.
export function resolveProviderConnectionPath(path: string, method: unknown, staticDashboard: boolean, apiBaseUrl: unknown, rolloutProviderConnect = false): string {
  if (!staticDashboard) return path
  const connect = /^\/api\/(google|bing)\/connect$/.exec(path)
  if (connect) {
    if (!rolloutProviderConnect) throw new Error(PROVIDER_CONNECT_HELD)
    if (method !== 'POST') throw new Error('Provider Connect requires POST.')
    return `${websiteApiOrigin(apiBaseUrl)}/providers/${connect[1]}/connect`
  }
  if (/^\/api\/(google|bing)\/connect[/?#]/.test(path)) throw new Error('Unsupported provider Connect path.')
  if (method !== 'GET' && method !== 'DELETE') return path
  const match = /^\/api\/(google|bing)\/connection$/.exec(path)
  return match ? `${websiteApiOrigin(apiBaseUrl)}/providers/${match[1]}/connection` : path
}

export const PROVIDER_CONNECT_HELD = 'New provider connections are not available yet. Existing connections and saved reports remain available.'

export type ConnectProvider = 'google' | 'bing'

// Never navigate to an arbitrary URL returned by a Connect response.
export function providerAuthorizationUrl(provider: ConnectProvider, result: unknown, apiBaseUrl?: unknown): string {
  const value = (result as { url?: unknown } | null)?.url
  if (typeof value !== 'string') throw new Error('The provider authorization URL is not valid.')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('The provider authorization URL is not valid.') }
  const allowed = apiBaseUrl !== undefined
    ? url.origin === websiteApiOrigin(apiBaseUrl) && url.pathname === `/auth/${provider}/start` && url.searchParams.getAll('ticket').length === 1 && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('ticket') ?? '') && [...url.searchParams.keys()].every(key => key === 'ticket')
    : provider === 'google'
    ? url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth'
    : provider === 'bing' && url.origin === 'https://www.bing.com' && url.pathname === '/webmasters/oauth/authorize'
  if (!allowed || url.username || url.password || url.hash) throw new Error('The provider authorization URL is not valid.')
  return url.href
}
