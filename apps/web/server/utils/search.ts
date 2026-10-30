import type { H3Event } from 'h3'
import { googleAccessToken, requireDashboardUser } from './google'

export async function proxySearch(event: H3Event, action: 'properties' | 'dashboard' | 'inspect') {
  const user = await requireDashboardUser(event)
  const id = getRouterParam(event, 'id')
  if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw createError({ statusCode: 400, message: 'Choose a valid website.' })
  const token = action === 'inspect' ? await googleAccessToken(event, user.id, 'search') : null
  const body = await readBody(event)
  const result = await $fetch.raw(`${useRuntimeConfig(event).apiBaseUrl.replace(/\/$/, '')}/websites/${id}/search/${action}`, {
    method: 'POST', body, headers: { Authorization: user.authorization, ...(token ? { 'X-Google-Access-Token': token } : {}) },
    timeout: 35_000, redirect: 'error', retry: 0, ignoreResponseError: true,
  }).catch(() => { throw createError({ statusCode: 502, message: 'Could not reach Google Search. Try again.' }) })
  setResponseStatus(event, result.status)
  return result._data
}
