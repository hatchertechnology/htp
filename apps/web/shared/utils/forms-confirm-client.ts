import { websiteApiOrigin } from './websites-client'

export function confirmationUrl(staticDashboard: boolean, apiBaseUrl: unknown): string {
  return staticDashboard ? `${websiteApiOrigin(apiBaseUrl)}/forms/confirm` : '/api/forms/confirm'
}

export function confirmationBody(recipient_id: string, token: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(recipient_id) || !/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid confirmation link')
  return { recipient_id, token }
}

export function confirmed(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === true
}
