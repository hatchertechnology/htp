import type { H3Event } from 'h3'
import { requireDashboardUser } from './google'

export async function proxyInsight(event: H3Event, path: 'insights/report' | 'insights/history' | 'business/location') {
  const user = await requireDashboardUser(event)
  const id = getRouterParam(event, 'id')
  if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw createError({ statusCode: 400, message: 'Choose a valid website.' })
  const body = await readBody(event)
  const result = await $fetch.raw(`${useRuntimeConfig(event).apiBaseUrl}/websites/${id}/${path}`, {
    method: path === 'business/location' ? 'PUT' : 'POST', body,
    headers: { Authorization: user.authorization }, timeout: 15000, redirect: 'error', retry: 0, ignoreResponseError: true,
  }).catch(() => { throw createError({ statusCode: 502, message: 'Could not load saved website insights. Try again.' }) })
  setResponseStatus(event, result.status)
  return result._data
}
