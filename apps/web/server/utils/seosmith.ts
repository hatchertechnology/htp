import type { H3Event } from 'h3'
import { requireDashboardUser } from './google'
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export async function proxySeosmith(event: H3Event, action: 'history' | 'detail' | 'import') {
  const user = await requireDashboardUser(event)
  const id = getRouterParam(event, 'id'), run = getRouterParam(event, 'run')
  if (!id || !UUID.test(id) || (action === 'detail' && (!run || !UUID.test(run)))) throw createError({ statusCode: 400, message: 'Choose a valid website and run.' })
  const method = getMethod(event)
  if (method !== (action === 'import' ? 'POST' : 'GET')) throw createError({ statusCode: 405, message: 'Method not allowed.' })
  let body: { report_json: string } | undefined
  if (action === 'import') {
    const input = await readBody(event)
    if (typeof input?.report_json !== 'string' || new TextEncoder().encode(input.report_json).length > 16 * 1024 * 1024 || Object.keys(input).some(key => key !== 'report_json')) throw createError({ statusCode: 400, message: 'Choose a Seosmith JSON report under 16 MiB.' })
    body = { report_json: input.report_json }
  }
  const suffix = action === 'history' ? '' : action === 'import' ? '/import' : `/${run}`
  const query = getQuery(event)
  const result = await $fetch.raw(`${useRuntimeConfig(event).apiBaseUrl.replace(/\/$/, '')}/websites/${id}/seo/audits${suffix}`, {
    method: method as 'GET' | 'POST', body,
    query: action === 'history' ? { limit: query.limit ?? 50, before: query.before, before_id: query.before_id } : undefined,
    headers: { Authorization: user.authorization }, timeout: 30000, redirect: 'error', retry: 0, ignoreResponseError: true,
  }).catch(() => { throw createError({ statusCode: 502, message: 'Seosmith reports could not load. Try again.' }) })
  setHeader(event, 'Cache-Control', 'no-store')
  setResponseStatus(event, result.status)
  return result._data
}
