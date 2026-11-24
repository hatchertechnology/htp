import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { H3Event } from 'h3'
import { requireDashboardUser } from './google'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

// This route has a different contract from the generic proxy: a late upstream
// failure terminates the response. The dashboard must consume and validate it.
export async function streamSavedDetail(event: H3Event) {
  setHeader(event, 'Cache-Control', 'no-store')
  if (useRuntimeConfig(event).public.boundedSavedDetail !== true) {
    throw createError({ statusCode: 404 })
  }
  const user = await requireDashboardUser(event)
  const id = getRouterParam(event, 'id'), run = getRouterParam(event, 'run')
  if (!id || !UUID.test(id) || !run || !UUID.test(run)) {
    throw createError({
      statusCode: 400,
      message: 'Choose a valid website and run.',
    })
  }
  const abort = new AbortController()
  const res = event.node.res
  const onClose = () => {
    if (!res.writableFinished) abort.abort()
  }
  res.once('close', onClose)
  // Bound both header wait and a stalled body; late expiry terminates the stream.
  const timer = setTimeout(() => abort.abort(), 120_000)
  try {
    const upstream = await fetch(
      `${
        useRuntimeConfig(event).apiBaseUrl.replace(/\/$/, '')
      }/websites/${id}/seo/audits/${run}`,
      {
        headers: { Authorization: user.authorization },
        redirect: 'error',
        signal: abort.signal,
      },
    )
    setHeader(
      event,
      'Content-Type',
      upstream.headers.get('content-type') || 'application/octet-stream',
    )
    setResponseStatus(event, upstream.status)
    if (!upstream.body) {
      res.end()
      return
    }
    await pipeline(
      Readable.fromWeb(
        upstream.body as import('node:stream/web').ReadableStream,
      ),
      res,
      { signal: abort.signal },
    )
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      throw createError({
        statusCode: 502,
        message: 'Seosmith reports could not load. Try again.',
      })
    }
    if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined)
  } finally {
    clearTimeout(timer)
    abort.abort()
    res.off('close', onClose)
  }
}
