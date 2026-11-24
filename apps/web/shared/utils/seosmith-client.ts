// Browser-side routing for the saved Seosmith reads: the run history list and one run's detail.
// Default (staticDashboard false): paths are returned unchanged and the same-origin Nuxt proxy serves them.
// Static (staticDashboard true): the HTP API origin is called directly with the owner's bearer.
// Only these two reads are routed. Import, lifecycle, url-lifecycle, work and bounded-detail
// /dashboard calls keep their existing paths; they are not part of the static transport.
import { websiteApiOrigin } from './websites-client'

const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
// The audit collection, or one run in a website. No query string, dot segments or further sub-resources.
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

// Static detail bounds. The size matches the import limit the API enforces on report_json; the deadline matches the bounded server proxy.
export const SAVED_DETAIL_MAX_BYTES = 4_952_756
export const SAVED_DETAIL_DEADLINE_MS = 120_000

// Reads a response body as JSON text, refusing a declared or streamed body above maxBytes.
// Throws on any transport error, cap breach or malformed JSON. Callers own the deadline via the signal.
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (response.headers.get('content-length') !== null && (!Number.isFinite(declared) || declared > maxBytes)) throw new Error('Saved detail exceeds the size limit.')
  const chunks: Uint8Array[] = []
  let total = 0
  if (response.body) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('Saved detail exceeds the size limit.')
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes))
}
