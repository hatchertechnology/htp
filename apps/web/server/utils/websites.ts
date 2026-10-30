import type { H3Event } from 'h3'
import { FQDN_ERROR, normalizeFqdn } from '#shared/utils/fqdn'

export async function proxyWebsites(event: H3Event, id?: string) {
  const method = getMethod(event)
  if (!(id ? ['GET', 'PATCH', 'DELETE'] : ['GET', 'POST']).includes(method)) {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }
  const authorization = getHeader(event, 'authorization')
  if (!authorization || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/i.test(authorization)) {
    throw createError({ statusCode: 401, message: 'Sign in to manage your websites.' })
  }
  if (id && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw createError({ statusCode: 400, message: 'Invalid website ID.' })
  }
  let body: { fqdn: string } | undefined
  if (method === 'POST' || method === 'PATCH') {
    const input = await readBody(event)
    const fqdn = typeof input?.fqdn === 'string' ? normalizeFqdn(input.fqdn) : null
    if (!fqdn || Object.keys(input).some(key => key !== 'fqdn')) throw createError({ statusCode: 400, message: FQDN_ERROR })
    body = { fqdn }
  }
  const query = getQuery(event)
  setHeader(event, 'Cache-Control', 'no-store')
  let result
  try {
    result = await $fetch.raw(`${useRuntimeConfig(event).apiBaseUrl.replace(/\/$/, '')}/websites${id ? `/${id}` : ''}`, {
      method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE', body,
      query: method === 'GET' && !id ? { limit: String(query.limit ?? 50), offset: String(query.offset ?? 0) } : undefined,
      headers: { Authorization: authorization },
      timeout: 15_000, retry: 0, redirect: 'error', ignoreResponseError: true,
    })
  } catch { throw createError({ statusCode: 502, message: 'Could not reach your API. Please try again.' }) }
  setResponseStatus(event, result.status)
  return result._data ?? null
}
