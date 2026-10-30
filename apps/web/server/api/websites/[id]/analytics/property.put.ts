import { requireDashboardUser } from '../../../../utils/google'
export default defineEventHandler(async (event) => {
  const user = await requireDashboardUser(event)
  const id = getRouterParam(event, 'id')
  if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw createError({ statusCode: 400, message: 'Choose a valid website.' })
  const body = await readBody(event)
  if (typeof body?.property_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(body.property_id)) throw createError({ statusCode: 400, message: 'Enter a numeric GA4 property ID.' })
  const result = await $fetch.raw(`${useRuntimeConfig(event).apiBaseUrl}/websites/${id}/analytics/property`, { method: 'PUT', body: { property_id: body.property_id }, headers: { Authorization: user.authorization }, timeout: 15_000, retry: 0, redirect: 'error', ignoreResponseError: true })
  setResponseStatus(event, result.status)
  return result._data
})
