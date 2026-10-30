import { requireDashboardUser } from '../../../../utils/google'

export default defineEventHandler(async (event) => {
  const user = await requireDashboardUser(event)
  const id = getRouterParam(event, 'id')
  if (!id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw createError({ statusCode: 400, message: 'Choose a valid website.' })
  const input = await readBody(event)
  // The Rust API validates ownership, dates and property, and fixes all report shapes.
  const result = await $fetch.raw(`${useRuntimeConfig(event).apiBaseUrl}/websites/${id}/analytics/dashboard`, {
    method: 'POST', body: input, headers: { Authorization: user.authorization },
    timeout: 35_000, redirect: 'error', retry: 0, ignoreResponseError: true,
  }).catch(() => { throw createError({ statusCode: 502, message: 'Could not reach Analytics. Try again.' }) })
  setResponseStatus(event, result.status)
  return result._data
})
