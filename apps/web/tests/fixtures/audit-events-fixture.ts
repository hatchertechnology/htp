import * as vue from 'vue'
// Mounts the production AuditEvents.vue with a mocked `$supabase.rpc`. Synthetic data only:
// no hosted backend, session or provider is used. `?mode=` selects the scenario.
Object.assign(globalThis, vue)
const params = new URLSearchParams(location.search), mode = params.get('mode') ?? 'default'
const SITE = '10000000-0000-0000-0000-000000000001'
const id = (n: number) => `20000000-0000-0000-0000-${String(n).padStart(12, '0')}`
// `?mode=<state>` or `?mode=<state>-empty`; `empty` is producer_unavailable with no rows.
const state = mode.replace(/-empty$/, '')
const empty = mode === 'empty' || mode.endsWith('-empty')
const availability = state === 'active' ? 'producer_active' : state === 'degraded' ? 'producer_degraded' : state === 'stale' ? 'producer_stale' : state === 'not-enqueuing' ? 'producer_not_enqueuing' : state === 'starting' ? 'producer_starting' : 'producer_unavailable'
// Episodes only carry the two operational codes in the 1.4 amendment.
const episodeAvailability = availability === 'producer_active' ? 'producer_active' : 'producer_unavailable'
const producer = { processing_enabled: true, enqueue_enabled: true, last_run_at: '2026-11-26T12:00:00Z', last_success_at: null, last_outcome: 'retry', pending: 4, held: 2, held_by_reason: { processor_unavailable: 2 }, counts_capped: false }
const event = (n: number, kind: string, severity: string, extra: Record<string, unknown> = {}) => ({ id: id(n), delivery_id: id(900 + n), baseline_id: id(800 + n), semantics_version: 1, entity_id: 'sha256:' + String(n).repeat(8), rule: 'missing_title', kind, severity, source_locator: `https://example.test/page-${n}`, created_at: `2026-11-2${n}T01:30:00+00:00`, ...extra })
const calls: { rpc: string; args: Record<string, unknown> }[] = []
let olderFailures = mode === 'older-fails' ? 1 : 0
const pages: Record<string, (args: Record<string, unknown>) => unknown> = {
  audit_event_history: args => {
    if (mode === 'malformed') return { semantics_version: 1, events: 'none', has_more: false, next_cursor: null, availability }
    if (empty) return { semantics_version: 1, events: [], has_more: false, next_cursor: null, availability, producer }
    if (args.p_before) {
      if (olderFailures-- > 0) throw new Error('older page failed')
      return { semantics_version: 1, events: [event(1, 'severity_increased', 'critical')], has_more: false, next_cursor: null, availability }
    }
    return { semantics_version: 1, events: [event(3, 'new', 'alert', { source_locator: '<img src=x onerror="window.__xss=1">' }), event(2, 'reopened', 'warning')], has_more: true, next_cursor: { before: '2026-11-22T01:30:00+00:00', before_id: id(2) }, availability, producer }
  },
  audit_operational_history: () => empty
    ? { version: 1, episodes: [], has_more: false, next_cursor: null, availability: episodeAvailability }
    : { version: 1, episodes: [{ id: id(51), source: 'google', job_id: null, error_class: 'quota', opened_at: '2026-11-20T12:00:00+00:00', recovered_at: null }, { id: id(52), source: 'bing', job_id: null, error_class: 'timeout', opened_at: '2026-11-19T12:00:00+00:00', recovered_at: '2026-11-19T15:00:00+00:00' }], has_more: false, next_cursor: null, availability: episodeAvailability },
}
Object.assign(globalThis, {
  __calls: calls,
  useNuxtApp: () => ({ $supabase: { rpc: async (rpc: string, args: Record<string, unknown>) => { calls.push({ rpc, args }); try { return { data: pages[rpc]!(args), error: null } } catch { return { data: null, error: { message: 'failed' } } } } } }),
})
const { default: AuditEvents } = await import('../../app/components/AuditEvents.vue')
vue.createApp(AuditEvents, { websiteId: SITE }).mount('#app')
