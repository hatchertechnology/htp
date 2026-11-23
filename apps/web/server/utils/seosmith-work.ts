import type { H3Event } from 'h3'
import { requireDashboardUser } from './google'
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export async function proxySeosmithWork(event: H3Event, action: 'list' | 'save' | 'attempt') {
  const user = await requireDashboardUser(event)
  if (useRuntimeConfig(event).public.rolloutRemediation !== true) throw createError({ statusCode: 503, message: 'Remediation is not available yet.' })
  const id = getRouterParam(event, 'id'), run = getRouterParam(event, 'run'), work = getRouterParam(event, 'work')
  if (!id || !uuid.test(id) || (action === 'attempt' ? !work || !uuid.test(work) : !run || !uuid.test(run))) throw createError({ statusCode: 400, message: 'Choose a valid website and audit.' })
  const method = action === 'list' ? 'GET' : 'POST'
  const suffix = action === 'attempt' ? `/work/${work}/attempts` : `/audits/${run}/work`
  const body = action === 'list' ? undefined : await readBody(event)
  const result = await $fetch.raw(`${useRuntimeConfig(event).apiBaseUrl.replace(/\/$/, '')}/websites/${id}/seo${suffix}`, {
    method, body, query: action === 'list' ? { finding_index: getQuery(event).finding_index, before: getQuery(event).before, before_id: getQuery(event).before_id } : undefined, headers: { Authorization: user.authorization }, timeout: 30000, redirect: 'error', retry: 0, ignoreResponseError: true,
  }).catch(() => { throw createError({ statusCode: 502, message: 'Remediation work could not load. Try again.' }) })
  setHeader(event, 'Cache-Control', 'no-store'); setResponseStatus(event, result.status)
  return result._data
}
