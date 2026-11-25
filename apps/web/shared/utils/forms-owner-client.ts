// Static-build owner Forms client for the gated pilot (REST through the HTP API).
// Every browser request goes to the HTP API origin with the caller's bearer. Routes are a closed allowlist,
// bodies are built from allowlisted fields only, and ownership, pilot approval, grants and DNS verification
// stay in the API and the database. Nothing here reaches Supabase tables, RPCs or Edge Functions.
import { websiteApiOrigin } from './websites-client'

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const UUID_RE = new RegExp(`^${UUID}$`, 'i')
const TOKEN_PREFIX = 'htp-verification='
const TOKEN_RE = /^[0-9a-f]{64}$/i
// Closed owner-management routes, including separately gated notifications. Response paths use their own scoped clients.
const ROUTES = [
  new RegExp(`^/websites/${UUID}/forms/${UUID}/(?:recipients(?:/${UUID}/disable)?|delivery-jobs(?:/${UUID}/retry)?)$`, 'i'),
  new RegExp(`^/websites/${UUID}/forms(?:/(?:pilot-eligibility|hosts|origins|host-verifications))?$`, 'i'),
  new RegExp(`^/forms/host-verifications/${UUID}/confirm$`, 'i'),
]

export const OWNER_PAGE_SIZE = 100

export type OwnerPage<T> = { items: T[]; has_more: boolean }
export type OwnerField = { key: string; label: string; kind: 'text' | 'email' | 'telephone' | 'multiline'; required: boolean; max_length: number }
export type OwnerChallenge = { host_id: string; txt_name: string; txt_value: string }
export type OwnerStep = 'begin' | 'confirm' | 'save-create' | 'save-update' | 'list'

// Local errors carry a stable code so the caller can tell "never sent" from an ambiguous network outcome.
function localError(message: string, code: string): Error {
  return Object.assign(new Error(message), { data: { code } })
}

export function sessionEndedError(): Error {
  return localError('Your session has ended. Sign in again.', 'unauthorized')
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw localError('Unsupported forms request.', 'not_sent')
  return value
}

export const ownerPath = {
  eligibility: (websiteId: string) => `/websites/${uuid(websiteId)}/forms/pilot-eligibility`,
  hosts: (websiteId: string) => `/websites/${uuid(websiteId)}/forms/hosts`,
  origins: (websiteId: string) => `/websites/${uuid(websiteId)}/forms/origins`,
  forms: (websiteId: string) => `/websites/${uuid(websiteId)}/forms`,
  begin: (websiteId: string) => `/websites/${uuid(websiteId)}/forms/host-verifications`,
  confirm: (hostId: string) => `/forms/host-verifications/${uuid(hostId)}/confirm`,
}

export function ownerUrl(path: string, apiBaseUrl: unknown, query: Record<string, string | number> = {}): string {
  if (!ROUTES.some(route => route.test(path))) throw localError('Unsupported forms request.', 'not_sent')
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) params.set(key, String(value))
  const search = params.toString()
  let origin: string
  try { origin = websiteApiOrigin(apiBaseUrl) } catch (cause) { throw localError(cause instanceof Error ? cause.message : 'The API base URL is not valid.', 'not_sent') }
  return `${origin}${path}${search ? `?${search}` : ''}`
}

export function pageQuery(offset: number): { limit: number; offset: number } {
  if (!Number.isInteger(offset) || offset < 0) throw localError('Unsupported forms page offset.', 'not_sent')
  return { limit: OWNER_PAGE_SIZE, offset }
}

export function originQuery(formId: string, offset: number): { form_id: string; limit: number; offset: number } {
  return { form_id: uuid(formId), ...pageQuery(offset) }
}

// The API requires the exact lowercase hostname. Trimming and lowercasing matches the existing RPC path.
export function beginBody(hostname: string): { hostname: string } {
  return { hostname: hostname.trim().toLowerCase() }
}

// Extracts the 64-hex token from the published TXT value `htp-verification=<token>`. Anything else is refused locally.
export function tokenFromTxtValue(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith(TOKEN_PREFIX)) throw localError('Unsupported verification value.', 'not_sent')
  const token = value.slice(TOKEN_PREFIX.length)
  if (!TOKEN_RE.test(token)) throw localError('Unsupported verification value.', 'not_sent')
  return token
}

export function confirmBody(txtValue: unknown): { token: string } {
  return { token: tokenFromTxtValue(txtValue) }
}

// A begin success is trusted only when it has the shape the confirm step needs. Otherwise the outcome is unknown.
export function parseChallenge(value: unknown): OwnerChallenge | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.host_id !== 'string' || !UUID_RE.test(record.host_id)) return null
  if (typeof record.txt_name !== 'string' || !record.txt_name || record.txt_name.length > 253) return null
  try { tokenFromTxtValue(record.txt_value) } catch { return null }
  return { host_id: record.host_id, txt_name: record.txt_name, txt_value: record.txt_value as string }
}

export function isVerifiedResult(value: unknown, hostId: string): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.verified === true && record.host_id === hostId
}

export function saveBody(input: { formId: string | null; formKey: string; name: string; fields: OwnerField[]; active: boolean; hostIds: string[] }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    form_key: input.formKey,
    name: input.name,
    fields: input.fields.map(({ key, label, kind, required, max_length }) => ({ key, label, kind, required, max_length })),
    active: input.active,
    host_ids: input.hostIds.map(hostId => uuid(hostId)),
  }
  // Absent form_id creates. Present form_id updates that form only.
  if (input.formId !== null) body.form_id = uuid(input.formId)
  return body
}

export function isSavedResult(value: unknown, formKey: string): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && UUID_RE.test(record.id) && record.form_key === formKey
}

// Definite refusals: the API or database reports that nothing was written. Every other failure is ambiguous.
const VERIFY_REFUSED = new Set(['not_sent', 'forms_verification_disabled', 'website_not_found', 'host_not_found', 'unauthorized', 'invalid_request', 'rate_limited', 'host_limit', 'dns_record_not_verified', 'challenge_expired_or_changed'])
const SAVE_REFUSED = new Set(['not_sent', 'forms_owner_save_disabled', 'not_found', 'unauthorized', 'invalid_request'])

function refusedCode(cause: unknown): string | null {
  const code = (cause as { data?: { code?: unknown } } | null)?.data?.code
  return typeof code === 'string' ? code : null
}

// True when a write may have committed (transport error, timeout, 5xx, malformed success, or an unlisted code).
// Reads never change state, so the list step is never treated as an unknown write.
export function isUnknownOutcome(step: OwnerStep, cause: unknown): boolean {
  if (step === 'list') return false
  const code = refusedCode(cause)
  if (code === null) return true
  const refused = step === 'save-create' || step === 'save-update' ? SAVE_REFUSED : VERIFY_REFUSED
  return !refused.has(code)
}

const NOT_SENT = 'This request was not sent. Reload the page and try again.'
const SESSION = 'Your session has ended. Sign in again.'
const UNKNOWN: Record<Exclude<OwnerStep, 'list'>, string> = {
  begin: 'The DNS challenge may or may not have been created. Reload the forms before creating another challenge.',
  confirm: 'Verification status is unknown. Do not publish a different value. The host list is reloaded, and verify stays disabled until the host shows as verified.',
  'save-create': 'The form may or may not have been saved. Check the forms list before saving again. The save was not retried.',
  'save-update': 'The form may or may not have been saved. Reopen this form to check its saved state before saving again.',
}
const FALLBACK: Record<Exclude<OwnerStep, 'list'>, string> = {
  begin: 'Could not create the DNS challenge. Try again.',
  confirm: 'Could not verify the DNS record. Try again.',
  'save-create': 'The form was not saved.',
  'save-update': 'The form was not saved.',
}
const REFUSED: Record<Exclude<OwnerStep, 'list'>, Record<string, string>> = {
  begin: {
    rate_limited: 'Too many verification requests. Try again in 10 minutes.',
    host_limit: 'This website has reached its limit of 64 hosts.',
    website_not_found: 'Host verification is not available for this website.',
    host_not_found: 'Host verification is not available for this website.',
    forms_verification_disabled: 'Host verification is not available for this website.',
    unauthorized: SESSION,
    invalid_request: 'Enter a valid hostname such as www.example.com.',
    not_sent: NOT_SENT,
  },
  confirm: {
    dns_record_not_verified: 'Could not verify the DNS record yet. Check the value and try again.',
    challenge_expired_or_changed: 'This challenge expired or was replaced. Create a new DNS challenge.',
    rate_limited: 'Too many verification requests. Try again in 10 minutes.',
    host_not_found: 'This host is not available for verification.',
    website_not_found: 'This host is not available for verification.',
    forms_verification_disabled: 'Host verification is not available for this website.',
    unauthorized: SESSION,
    invalid_request: 'The verification token was refused. Create a new DNS challenge.',
    not_sent: NOT_SENT,
  },
  'save-create': {
    forms_owner_save_disabled: 'Form saving is not available right now.',
    not_found: 'This website or form is not available.',
    unauthorized: SESSION,
    invalid_request: 'The form was refused. Check the name, key, fields and verified hosts.',
    not_sent: NOT_SENT,
  },
  'save-update': {
    forms_owner_save_disabled: 'Form saving is not available right now.',
    not_found: 'This website or form is not available.',
    unauthorized: SESSION,
    invalid_request: 'The form was refused. Check the name, key, fields and verified hosts.',
    not_sent: NOT_SENT,
  },
}

// User-facing text for a failed owner step. Ambiguous outcomes never read as a plain failure.
export function ownerMessage(step: OwnerStep, cause: unknown): string {
  if (step === 'list') return 'Could not load forms. Please try again.'
  if (isUnknownOutcome(step, cause)) return UNKNOWN[step]
  const code = refusedCode(cause)
  return (code !== null && REFUSED[step][code]) || FALLBACK[step]
}
