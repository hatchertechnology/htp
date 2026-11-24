import { websiteApiOrigin } from './websites-client'
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
const PATH = new RegExp(`^/websites/${UUID}/forms/${UUID}/responses/${UUID}(?:/status)?$`, 'i')
export type ResponseStatus = 'new' | 'reviewed' | 'spam'
export function responseUrl(site: string, form: string, response: string, status: boolean, base: unknown): string {
  const path = `/websites/${site}/forms/${form}/responses/${response}${status ? '/status' : ''}`
  if (!PATH.test(path)) throw Object.assign(new Error('Unsupported response request.'), { data: { code: 'not_sent' } })
  return `${websiteApiOrigin(base)}${path}`
}
export function responseBody(status: string): { status: ResponseStatus } {
  if (!['new', 'reviewed', 'spam'].includes(status)) throw Object.assign(new Error('Unsupported response status.'), { data: { code: 'not_sent' } })
  return { status: status as ResponseStatus }
}
export function responseResult(value: unknown, id: string, status?: string): boolean {
  const row = value as { id?: unknown; status?: unknown; deleted?: unknown } | null
  return row?.id === id && (status === undefined ? row.deleted === true : row.status === status)
}
export function responseUnknown(cause: unknown): boolean {
  const code = (cause as { data?: { code?: string } } | null)?.data?.code
  return !['not_sent', 'forms_owner_response_disabled', 'not_found', 'unauthorized', 'invalid_request', 'response_notification_sending'].includes(code ?? '')
}
export function responseMessage(cause: unknown, deleting: boolean): string {
  if (responseUnknown(cause)) return `The response ${deleting ? 'deletion' : 'status'} outcome is unknown. An inbox reload was attempted; reopen Responses and check the saved state before another explicit attempt. The request was not retried. An absent response does not prove this request deleted it.`
  const code = (cause as { data?: { code?: string } } | null)?.data?.code
  if (code === 'response_notification_sending') return 'This response cannot be deleted while a notification is sending.'
  if (code === 'unauthorized') return 'Your session has ended. Sign in again.'
  return 'Response management is unavailable or the request was refused. Reload the inbox before trying again.'
}
export function staticResponseEnabled(staticDashboard: unknown, pilot: unknown, enabled: unknown): boolean {
  return staticDashboard === true && pilot === true && enabled === true
}
