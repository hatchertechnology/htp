// Browser-side routing for the saved Seosmith reads: the run history list and one run's detail.
// Default (staticDashboard false): paths are returned unchanged and the same-origin Nuxt proxy serves them.
// Static (staticDashboard true): the HTP API origin is called directly with the owner's bearer.
// Import has a separate exact POST mapping. Gated lifecycle/work transport is handled
// by the workspace gated-evidence client. Bounded /dashboard detail remains separate.
import { websiteApiOrigin } from './websites-client'

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
// The audit collection, or one run in a website. No query string, dot segments or further sub-resources.
const SEOSMITH_IMPORT_PATH = new RegExp(`^/api/websites/(${UUID})/seo/audits/import$`, 'i')
const RECEIPT_ID = new RegExp(`^${UUID}$`, 'i')
const SEOSMITH_READ_PATH = new RegExp(`^/api/websites/(${UUID})/seo/audits(?:/(${UUID}))?$`, 'i')

// Same media-type rule the bounded saved-detail reader has always applied.
export const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i

export function resolveSeosmithReadPath(path: string, staticDashboard: boolean, apiBaseUrl: unknown): string {
  if (!staticDashboard) return path
  const match = SEOSMITH_READ_PATH.exec(path)
  if (!match) throw new Error('Unsupported Seosmith request path.')
  const [, site, run] = match
  return `${websiteApiOrigin(apiBaseUrl)}/websites/${site}/seo/audits${run ? `/${run}` : ''}`
}

// Import-file limit: the API refuses a report_json above this many UTF-8 bytes (see the Seosmith import routes).
// It is an input limit only. It does not bound the saved detail body, which carries the parsed report and the raw report_json.
export const SEOSMITH_IMPORT_MAX_BYTES = 4_952_756
// Saved-detail deadline, matching the server-side bounded proxy. It covers headers and body.
export const SAVED_DETAIL_DEADLINE_MS = 120_000

// Owner import only: keep the legacy Nitro path when static transport is disabled.
export function resolveSeosmithImportPath(path: string, staticDashboard: boolean, apiBaseUrl: unknown): string {
  if (!staticDashboard) return path
  if (SEOSMITH_IMPORT_PATH.exec(path)?.[0] !== path) throw new Error('Unsupported Seosmith import path.')
  return `${websiteApiOrigin(apiBaseUrl)}${path.slice(4)}`
}

export function isImportReceipt(value: unknown): value is { delivery_id: string } {
  return typeof value === 'object' && value !== null && 'delivery_id' in value
    && typeof value.delivery_id === 'string' && value.delivery_id.length === 36 && RECEIPT_ID.test(value.delivery_id)
}
