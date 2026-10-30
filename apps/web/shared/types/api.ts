export type Transport = 'rest' | 'mcp'
export type Access = 'public' | 'secured'
export type Operation = 'call' | 'list'

export interface PlaygroundRequest {
  transport: Transport
  access: Access
  operation?: Operation
}

export interface PlaygroundResponse {
  status: number
  statusText: string
  durationMs: number
  contentType: string
  body: unknown
}
