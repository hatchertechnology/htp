import type { H3Event } from 'h3'
import { requireDashboardUser } from './google'
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export async function proxySeosmith(event: H3Event, action: 'history' | 'detail' | 'import' | 'lifecycle' | 'url-lifecycle') {
  const user = await requireDashboardUser(event)
  const id = getRouterParam(event, 'id'), run = getRouterParam(event, 'run')
  if (!id || !UUID.test(id) || (action === 'detail' && (!run || !UUID.test(run)))) throw createError({ statusCode: 400, message: 'Choose a valid website and run.' })
  const method = getMethod(event)
  if (method !== (action === 'import' ? 'POST' : 'GET')) throw createError({ statusCode: 405, message: 'Method not allowed.' })
  let body: { report_json: string } | undefined
  if (action === 'import') {
    const input = await readBody(event)
    if (typeof input?.report_json !== 'string' || Object.keys(input).some(key => key !== 'report_json')) throw createError({ statusCode: 400, message: 'Choose a Seosmith JSON report.' })
    if (new TextEncoder().encode(input.report_json).length > 4_952_756) throw createError({ statusCode: 413, message: 'report_limit' })
    body = { report_json: input.report_json }
  }
  const suffix = action === 'history' ? '' : action === 'import' ? '/import' : action === 'lifecycle' ? '/lifecycle' : action === 'url-lifecycle' ? '/url-lifecycle' : `/${run}`
  const query = getQuery(event)
  const result = await $fetch.raw(`${useRuntimeConfig(event).apiBaseUrl.replace(/\/$/, '')}/websites/${id}/seo/audits${suffix}`, {
    method: method as 'GET' | 'POST', body,
    query: action === 'url-lifecycle' ? { entity_id: query.entity_id, limit: query.limit ?? 50, before: query.before, before_id: query.before_id } : action === 'history' ? { limit: query.limit ?? 50, before: query.before, before_id: query.before_id } : action === 'lifecycle' ? { entity_id: query.entity_id, rule: query.rule, limit: query.limit ?? 50, before: query.before, before_id: query.before_id } : undefined,
    headers: { Authorization: user.authorization }, timeout: 30000, redirect: 'error', retry: 0, ignoreResponseError: true,
  }).catch(() => { throw createError({ statusCode: 502, message: 'Seosmith reports could not load. Try again.' }) })
  setHeader(event, 'Cache-Control', 'no-store')
  setResponseStatus(event, result.status)
  return result._data
}
