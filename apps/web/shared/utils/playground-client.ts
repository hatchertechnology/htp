import type { PlaygroundRequest } from '../types/api'
import { websiteApiOrigin } from './websites-client'

export function playgroundTarget(request: PlaygroundRequest, staticDashboard: boolean, apiBaseUrl: unknown) {
  if (!staticDashboard) return { url: '/api/playground', body: request }
  if (!['public', 'secured'].includes(request.access) || !['rest', 'mcp'].includes(request.transport) || (request.operation !== undefined && !['call', 'list'].includes(request.operation))) throw new Error('Unsupported playground request.')
  return {
    url: `${websiteApiOrigin(apiBaseUrl)}/playground/${request.access}`,
    body: { transport: request.transport, operation: request.operation ?? 'call' },
  }
}
