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

export function isPublicRoute(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false
  const pathname = path.split(/[?#]/)[0] ?? ''
  const normalised = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname
  return PUBLIC_PATHS.includes(normalised)
}
