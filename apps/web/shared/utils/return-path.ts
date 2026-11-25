// Post sign-in return path. Only a same-origin absolute path is ever returned:
// never another host, never a scheme, never the sign-in page itself.
import { isSignInPath } from './public-routes'

const BASE = 'https://return.invalid'
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/

function hasControls(value: string): boolean {
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { return true }
  return CONTROLS.test(value) || CONTROLS.test(decoded)
}

export function safeReturnPath(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || raw === '' || raw.length > 2048) return null
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null
  if (raw.includes('\\')) return null
  if (/\s/.test(raw) || hasControls(raw)) return null
  let url: URL
  try { url = new URL(raw, BASE) } catch { return null }
  if (url.origin !== BASE) return null
  if (url.pathname.startsWith('//')) return null
  const decodedPath = (() => { try { return decodeURIComponent(url.pathname) } catch { return '' } })()
  if (decodedPath.startsWith('//') || CONTROLS.test(decodedPath)) return null
  // Any sign-in spelling (`/SIGN-IN`, `/%73ign-in`, `/sign-in//`) is a loop.
  if (isSignInPath(url.pathname)) return null
  return `${url.pathname}${url.search}${url.hash}`
}
