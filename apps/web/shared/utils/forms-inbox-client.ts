// Static-mode read helpers for the owner Forms inbox (GET only).
// Only the forms list and the response list are routed through the HTP API; every other path keeps its existing behavior.
// Reads are authenticated by the caller's bearer. The API remains authoritative for pilot affinity.
import { websiteApiOrigin } from './websites-client'

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
// Exactly the two read collections the client uses. No detail, recipient, delivery or write paths.
const FORMS_INBOX_PATH = new RegExp(`^/websites/${UUID}/forms(?:/${UUID}/responses)?$`, 'i')

export const FORMS_INBOX_PAGE_SIZE = 100

export type FormsInboxPage<T> = { items: T[]; has_more: boolean }

export function formsInboxPath(websiteId: string, formId?: string): string {
  const path = formId === undefined ? `/websites/${websiteId}/forms` : `/websites/${websiteId}/forms/${formId}/responses`
  if (!FORMS_INBOX_PATH.test(path)) throw new Error('Unsupported forms inbox request path.')
  return path
}

export function formsInboxUrl(path: string, page: { limit: number; offset: number }, apiBaseUrl: unknown): string {
  if (!FORMS_INBOX_PATH.test(path)) throw new Error('Unsupported forms inbox request path.')
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > FORMS_INBOX_PAGE_SIZE) throw new Error('Unsupported forms inbox page size.')
  if (!Number.isInteger(page.offset) || page.offset < 0) throw new Error('Unsupported forms inbox offset.')
  return `${websiteApiOrigin(apiBaseUrl)}${path}?limit=${page.limit}&offset=${page.offset}`
}

// Static reads are only considered when the static build is selected and the pilot rollout flag is on.
// Callers must still require a successful, authenticated eligibility read before using them.
export function staticFormsInboxReads(staticDashboard: unknown, rolloutFormsPilot: unknown): boolean {
  return staticDashboard === true && rolloutFormsPilot === true
}
