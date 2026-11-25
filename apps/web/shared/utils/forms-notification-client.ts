import { ownerUrl, pageQuery } from './forms-owner-client'
export type Collection = 'recipients' | 'delivery-jobs'
export type Recipient = { id: string; email: string; enabled: boolean; verified_at: string | null; created_at: string }
export type Delivery = { id: string; recipient_id: string; response_id: string | null; kind: string; state: string; attempts: number; created_at: string; updated_at: string }
export function notificationUrl(site: string, form: string, collection: Collection, base: unknown, offset?: number, item?: string): string {
  return ownerUrl(`/websites/${site}/forms/${form}/${collection}${item ? `/${item}/${collection === 'recipients' ? 'disable' : 'retry'}` : ''}`, base, offset === undefined ? {} : pageQuery(offset))
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 254
export function notificationPage(value: unknown, collection: Collection): { items: (Recipient | Delivery)[]; has_more: boolean } {
  const page = value as { items?: unknown; has_more?: unknown } | null
  if (!Array.isArray(page?.items) || page.items.length > 100 || typeof page.has_more !== 'boolean' || (page.has_more && !page.items.length)) throw new Error('Invalid notification page')
  const items = page.items.map((r: Record<string, unknown>) => {
    if (!r || typeof r.id !== 'string' || !uuid.test(r.id) || !text(r.created_at)) throw new Error('Invalid notification metadata')
    if (collection === 'recipients') {
      if (!text(r.email) || typeof r.enabled !== 'boolean' || !(r.verified_at === null || text(r.verified_at))) throw new Error('Invalid recipient')
      return { id: r.id, email: r.email, enabled: r.enabled, verified_at: r.verified_at, created_at: r.created_at }
    }
    if (typeof r.recipient_id !== 'string' || !uuid.test(r.recipient_id) || !(r.response_id === null || typeof r.response_id === 'string' && uuid.test(r.response_id)) || !['verification', 'response'].includes(String(r.kind)) || !['pending','sending','sent','failed','cancelled','uncertain'].includes(String(r.state)) || !Number.isInteger(r.attempts) || Number(r.attempts) < 0 || !text(r.updated_at)) throw new Error('Invalid delivery')
    return { id: r.id, recipient_id: r.recipient_id, response_id: r.response_id, kind: String(r.kind), state: String(r.state), attempts: Number(r.attempts), created_at: r.created_at, updated_at: r.updated_at }
  })
  return { items, has_more: page.has_more }
}
export function notificationResult(value: unknown, action: 'create' | 'disable' | 'retry', id?: string): boolean {
  const r = value as Record<string, unknown> | null
  if (!r) return false
  return action === 'create' ? typeof r.recipient_id === 'string' && uuid.test(r.recipient_id) && r.requested === true : action === 'disable' ? r.recipient_id === id && r.disabled === true : r.job_id === id && r.retry_requested === true
}
export function notificationUnknown(cause: unknown): boolean {
  const code = (cause as { data?: { code?: string } } | null)?.data?.code
  return !['not_sent','unauthorized','forms_notifications_disabled','not_found','invalid_request','notification_not_retryable'].includes(code ?? '')
}
