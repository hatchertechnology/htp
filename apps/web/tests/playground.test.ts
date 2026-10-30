import { describe, expect, it } from 'vitest'
import { parsePlaygroundRequest, toolRequest, upstreamPath } from '../server/utils/playground'

describe('playground request boundary', () => {
  it.each([null, undefined, '', [], {}, { transport: ['rest'], access: 'public' },
    { transport: 'rest', access: ['secured'] }, { transport: 'https://evil.example', access: 'public' },
    { transport: 'mcp', access: 'public', operation: 'delete' },
    { transport: 'mcp', access: 'admin' }, { transport: 'mcp', access: 'public', operation: ['call'] },
  ])('rejects invalid or coerced request values: %j', (input) => {
    expect(parsePlaygroundRequest(input)).toBeNull()
  })

  it.each([
    ['rest', 'public', '/'], ['rest', 'secured', '/secured'],
    ['mcp', 'public', '/mcp'], ['mcp', 'secured', '/mcp/secured'],
  ] as const)('routes %s %s to the correct fixed endpoint', (transport, access, path) => {
    const parsed = parsePlaygroundRequest({ transport, access, url: 'https://evil.example/' })!
    expect(upstreamPath(parsed)).toBe(path)
    expect(parsed).not.toHaveProperty('url')
  })

  it('selects only the allowed public or secured tool', () => {
    expect(toolRequest({ transport: 'mcp', access: 'public' })).toMatchObject({ method: 'tools/call', params: { name: 'hello_world', arguments: {} } })
    expect(toolRequest({ transport: 'mcp', access: 'secured' })).toMatchObject({ method: 'tools/call', params: { name: 'hello_world_secured', arguments: {} } })
    expect(toolRequest({ transport: 'mcp', access: 'secured', operation: 'list' })).toMatchObject({ method: 'tools/list' })
  })
})
