import { expect, it } from 'vitest'
import { confirmationBody, confirmationUrl, confirmed } from '../shared/utils/forms-confirm-client'
it('uses only the exact static API route and preserves legacy routing', () => {
  expect(confirmationUrl(true, 'https://api.example')).toBe('https://api.example/forms/confirm')
  expect(confirmationUrl(false, '')).toBe('/api/forms/confirm')
  expect(() => confirmationUrl(true, 'https://api.example/path')).toThrow()
})
it('requires canonical input and definite typed success', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  expect(confirmationBody(id, 'a'.repeat(64))).toEqual({recipient_id:id, token:'a'.repeat(64)})
  for (const token of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) expect(() => confirmationBody(id, token)).toThrow()
  for (const result of [null, true, {}, {ok:'true'}, {ok:false}]) expect(confirmed(result)).toBe(false)
  expect(confirmed({ok:true})).toBe(true)
})
