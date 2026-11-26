// Browser read of the held per-family evidence route (WP8c-3):
//   GET {api}/websites/{id}/seosmith/audits/{delivery}/evidence-families
// Owner bearer, read-only. The route is held by HTP_ROLLOUT_EVIDENCE_FAMILIES on the
// API and by NUXT_PUBLIC_ROLLOUT_EVIDENCE_FAMILIES here; with the web flag off no
// request is made. Every outcome is explicit, so an unreadable or refused response is
// never shown as an empty or zero result.
import { websiteApiOrigin } from './websites-client'
import { parseFamiliesEnvelope, type FamiliesResult } from './wire2-families'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export type FamiliesRuntime = { apiBaseUrl?: unknown; rolloutEvidenceFamilies?: unknown }
export type FamiliesFetcher = (url: string, options: Record<string, unknown>) => Promise<unknown>
export type FamiliesDeps = { runtime: FamiliesRuntime; accessToken: () => Promise<string | null>; fetcher: FamiliesFetcher }
export type FamiliesLoad = FamiliesResult | { kind: 'flag_off' } | { kind: 'not_found' } | { kind: 'unavailable'; message: string }

export function evidenceFamiliesUrl(apiBaseUrl: unknown, site: string, delivery: string): string {
  if (!UUID.test(site) || !UUID.test(delivery)) throw new Error('Invalid audit identifier.')
  return `${websiteApiOrigin(apiBaseUrl)}/websites/${site}/seosmith/audits/${delivery}/evidence-families`
}

function statusOf(error: unknown): number | null {
  const e = error as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } } | null
  const value = e?.statusCode ?? e?.status ?? e?.response?.status
  return typeof value === 'number' ? value : null
}

export async function loadEvidenceFamilies(deps: FamiliesDeps, site: string, delivery: string, signal?: AbortSignal): Promise<FamiliesLoad> {
  if (deps.runtime.rolloutEvidenceFamilies !== true) return { kind: 'flag_off' }
  let url: string
  try { url = evidenceFamiliesUrl(deps.runtime.apiBaseUrl, site, delivery) } catch { return { kind: 'unavailable', message: 'Evidence families cannot be read from this deployment.' } }
  try {
    const token = await deps.accessToken()
    if (!token) return { kind: 'unavailable', message: 'Sign in again to read evidence families.' }
    const raw = await deps.fetcher(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', retry: 0, timeout: 30_000, ...(signal ? { signal } : {}) })
    return parseFamiliesEnvelope(raw, delivery)
  } catch (error) {
    const status = statusOf(error)
    if (status === 503) return { kind: 'flag_off' }
    if (status === 404) return { kind: 'not_found' }
    return { kind: 'unavailable', message: 'Evidence families could not be read. This is not an empty result. Try again.' }
  }
}
