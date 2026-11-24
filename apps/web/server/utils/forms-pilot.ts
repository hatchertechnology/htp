import type { H3Event } from 'h3'
import { requireDashboardUser } from './google'

// UI visibility only. The database owner/site gate remains authoritative.
export async function pilotEligibility(event: H3Event) {
  setHeader(event, 'Cache-Control', 'no-store')
  const config = useRuntimeConfig(event)
  if ((config.public.rolloutFormsPilot !== true && config.public.rolloutFormsVerification !== true) || config.formsPilotEnabled !== true) return { eligible: false }
  const id = getQuery(event).website_id
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
  if (typeof id !== 'string' || !uuid.test(id) || !uuid.test(config.formsPilotWebsiteId) || !uuid.test(config.formsPilotOwnerId)) return { eligible: false }
  const user = await requireDashboardUser(event)
  if (id !== config.formsPilotWebsiteId || user.id !== config.formsPilotOwnerId) return { eligible: false }
  try {
    const result = await $fetch.raw(`${config.apiBaseUrl.replace(/\/$/, '')}/websites/${id}`, {
      headers: { Authorization: user.authorization }, timeout: 15_000, redirect: 'error', retry: 0, ignoreResponseError: true,
    })
    return { eligible: result.status === 200 && (result._data as { id?: string } | null)?.id === id }
  } catch { return { eligible: false } }
}
