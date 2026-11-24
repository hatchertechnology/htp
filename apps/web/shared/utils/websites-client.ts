// Browser-side routing for the website list/detail/create/update/delete endpoints.
// Default (staticDashboard false): keep the same-origin Nuxt /api/websites proxy.
// Static (staticDashboard true): call the HTP API origin directly with the owner's bearer.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
// Only the collection or one website UUID, optionally with a plain query string: no dot segments or sub-resources.
const WEBSITES_PATH = /^\/api(\/websites(?:\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?(?:\?[^#]*)?)$/i

export function websiteApiOrigin(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('The static dashboard needs an API base URL.')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('The static dashboard API base URL is not valid.') }
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('The static dashboard API base URL must be an https origin without credentials, path, query or fragment.')
  }
  return url.origin
}

export function resolveWebsitePath(path: string, staticDashboard: boolean, apiBaseUrl: unknown): string {
  if (!staticDashboard) return path
  const match = WEBSITES_PATH.exec(path)
  if (!match) throw new Error('Unsupported website request path.')
  return `${websiteApiOrigin(apiBaseUrl)}${match[1]}`
}
