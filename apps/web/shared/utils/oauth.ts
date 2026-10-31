/** Only an opaque authorization ID is accepted from the browser URL. */
export function authorizationId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : null
}

/** Redirects come from Supabase's validated consent response, never query input. */
export function consentRedirect(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Invalid authorization redirect. Start again from your agent.')
  }
  return url.href
}

export function scopeDescription(scope: string): string {
  return ({ openid: 'Identify your HTP account', email: 'Read your email address', profile: 'Read your profile information', phone: 'Read your phone number', offline_access: 'Stay connected until you revoke access' } as Record<string, string>)[scope] || scope
}
