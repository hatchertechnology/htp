// Routes a signed-out visitor may reach. Exact paths only: no prefixes, so a new
// page never becomes public by accident.
export const SIGN_IN_PATH = '/sign-in'

const PUBLIC_PATHS: readonly string[] = [
  SIGN_IN_PATH,
  '/oauth/consent',
  '/forms/confirm',
  '/auth/google/callback',
  '/auth/bing/callback',
]

function decodePath(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

// vue-router matches case-insensitively, so comparisons here are case-folded,
// percent-decoded and trailing-slash-insensitive. A repeated trailing slash
// (`/sign-in//`) must still be recognised as the sign-in page.
function normaliseRoutePath(path: string): string {
  const pathname = path.split(/[?#]/)[0] ?? ''
  const decoded = decodePath(pathname).toLowerCase()
  return decoded.length > 1 ? decoded.replace(/\/+$/, '') : decoded
}

export function isPublicRoute(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false
  return PUBLIC_PATHS.includes(normaliseRoutePath(path))
}

// The sign-in page itself. Used for the redirect branches so a signed-in visitor
// can never loop back to it, and a crafted `/SIGN-IN`, `/%73ign-in` or
// `/sign-in//` cannot skip the redirect or land on a 404.
export function isSignInPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false
  return normaliseRoutePath(path) === SIGN_IN_PATH
}
