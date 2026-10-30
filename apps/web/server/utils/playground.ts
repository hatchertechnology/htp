import type { PlaygroundRequest } from '../../shared/types/api'

export function parsePlaygroundRequest(input: unknown): PlaygroundRequest | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  if (typeof value.transport !== 'string' || !['rest', 'mcp'].includes(value.transport)) return null
  if (typeof value.access !== 'string' || !['public', 'secured'].includes(value.access)) return null
  if (value.operation !== undefined && (typeof value.operation !== 'string' || !['call', 'list'].includes(value.operation))) return null
  return { transport: value.transport as PlaygroundRequest['transport'], access: value.access as PlaygroundRequest['access'], operation: value.operation as PlaygroundRequest['operation'] }
}

export function upstreamPath(request: PlaygroundRequest) {
  if (request.transport === 'rest') return request.access === 'secured' ? '/secured' : '/'
  return request.access === 'secured' ? '/mcp/secured' : '/mcp'
}

export function toolRequest(request: PlaygroundRequest) {
  if (request.operation === 'list') return { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  return { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: request.access === 'secured' ? 'hello_world_secured' : 'hello_world', arguments: {} } }
}
