import type { PlaygroundResponse } from '../../shared/types/api'
import { parsePlaygroundRequest, toolRequest, upstreamPath } from '../utils/playground'

export default defineEventHandler(async (event): Promise<PlaygroundResponse> => {
  // The upstream origin is operator configuration, never a caller-supplied URL.
  const request = parsePlaygroundRequest(await readBody(event))
  if (!request) throw createError({ statusCode: 400, statusMessage: 'Choose a valid interface and access level.' })
  const config = useRuntimeConfig(event)
  const url = `${config.apiBaseUrl.replace(/\/$/, '')}${upstreamPath(request)}`
  const authorization = getHeader(event, 'authorization')
  const headers: Record<string, string> = { Accept: 'application/json, text/event-stream' }
  if (request.access === 'secured' && authorization) {
    if (!/^Bearer [A-Za-z0-9._~-]{1,8192}$/i.test(authorization)) throw createError({ statusCode: 401, statusMessage: 'A valid user access token is required.' })
    headers.Authorization = authorization
  }
  const started = performance.now()
  setHeader(event, 'Cache-Control', 'no-store')

  try {
    const send = (body?: object) => $fetch.raw<unknown>(url, {
      method: request.transport === 'rest' ? 'GET' : 'POST',
      headers,
      body,
      timeout: 15_000,
      retry: 0,
      redirect: 'error',
      ignoreResponseError: true,
    })
    const response = request.transport === 'rest' ? await send() : await (async () => {
      headers['MCP-Protocol-Version'] = '2025-11-25'
      const initialized = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'htp-web', version: '0.1.0' },
      } })
      if (!initialized.ok || (initialized._data as { error?: unknown } | undefined)?.error) return initialized
      const notified = await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      if (!notified.ok) return notified
      return send(toolRequest(request))
    })()

    setResponseStatus(event, response.status)
    return { status: response.status, statusText: response.statusText || (response.ok ? 'OK' : 'Request failed'),
      durationMs: Math.round(performance.now() - started), contentType: response.headers.get('content-type') || 'application/json', body: response._data ?? null }
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'The API did not respond. Wait a moment and try again.' })
  }
})
