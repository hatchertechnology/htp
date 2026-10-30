import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function key(secret: string) {
  const value = Buffer.from(secret, 'base64')
  if (value.length !== 32) throw new Error('Google connection encryption is not configured.')
  return value
}
export function seal(value: unknown, secret: string, purpose: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
  cipher.setAAD(Buffer.from(purpose))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
}
export function unseal<T>(value: string | undefined, secret: string, purpose: string): T | null {
  if (!value || value.length > 8192) return null
  try {
    const data = Buffer.from(value, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', key(secret), data.subarray(0, 12))
    decipher.setAAD(Buffer.from(purpose))
    decipher.setAuthTag(data.subarray(12, 28))
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()) as T
  } catch { return null }
}
