import { expect, it } from 'vitest'
import { normalizeFqdn } from '../shared/utils/fqdn'

it.each([
  [' WWW.DreamCleanMacon.COM. ', 'www.dreamcleanmacon.com'],
  ['bücher.de', 'xn--bcher-kva.de'], ['a.example.com', 'a.example.com'],
])('canonicalizes %s', (input, expected) => { expect(normalizeFqdn(input)).toBe(expected) })

it.each(['', 'localhost', 'https://example.com', 'example.com/path', 'example.com:443', 'user@example.com', '*.example.com', '127.0.0.1', '[::1]', 'bad..example.com', 'example.com..', '-bad.example.com', 'bad-.example.com', 'has space.com', 'bad_name.com', 'foo.123', 'example%2ecom', `${'a'.repeat(64)}.com`, `${Array(4).fill('a'.repeat(63)).join('.')}.com`])('rejects %s', input => {
  expect(normalizeFqdn(input)).toBeNull()
})
