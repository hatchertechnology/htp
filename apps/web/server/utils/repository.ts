import type { H3Event } from 'h3'
import { requireDashboardUser } from './google'
export async function proxyRepository(event: H3Event, resource: '' | 'issues' = '') {
  const user = await requireDashboardUser(event)
  const id = getRouterParam(event, 'id')
  if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw createError({ statusCode: 400, message: 'Choose a valid website.' })
  const method = getMethod(event)
  if (!(resource ? ['GET'] : ['GET', 'PUT']).includes(method)) throw createError({ statusCode: 405, message: 'Method not allowed.' })
  const body = method === 'PUT' ? await readBody(event) : undefined
  const result = await $fetch.raw(`${useRuntimeConfig(event).apiBaseUrl}/websites/${id}/repository${resource ? `/${resource}` : ''}`, {
    method: method as 'GET' | 'PUT', body, query: method === 'GET' ? getQuery(event) : undefined,
    headers: { Authorization: user.authorization }, timeout: 15000, redirect: 'error', retry: 0, ignoreResponseError: true,
  }).catch(() => { throw createError({ statusCode: 502, message: resource ? 'Could not load GitHub issues. Try again.' : 'Could not load repository history. Try again.' }) })
  setResponseStatus(event, result.status)
  return result._data
}
