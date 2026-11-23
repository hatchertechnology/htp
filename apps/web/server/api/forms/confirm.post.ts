export default defineEventHandler(async (event) => {
  if (useRuntimeConfig(event).public.rolloutForms !== true || useRuntimeConfig(event).public.rolloutFormsPilot === true) throw createError({ statusCode: 503, message: 'Form notifications are not available yet.' })
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of event.node.req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 1024) throw createError({ statusCode: 413, message: 'Confirmation request is too large.' })
    chunks.push(bytes)
  }
  let input: unknown
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw createError({ statusCode: 400, message: 'Invalid confirmation link.' }) }
  if (!input || typeof input !== 'object' || !('recipient_id' in input) || !('token' in input) || typeof input.recipient_id !== 'string' || typeof input.token !== 'string') throw createError({ statusCode: 400, message: 'Invalid confirmation link.' })
  setHeader(event, 'Cache-Control', 'no-store')
  try {
    const result = await $fetch.raw(`${useRuntimeConfig(event).public.supabaseUrl}/functions/v1/form-confirm-recipient`, { method: 'POST', body: { recipient_id: input.recipient_id, token: input.token }, timeout: 10_000, retry: 0, redirect: 'error', ignoreResponseError: true })
    setResponseStatus(event, result.status)
    return result._data
  } catch { throw createError({ statusCode: 503, message: 'Confirmation is temporarily unavailable.' }) }
})
