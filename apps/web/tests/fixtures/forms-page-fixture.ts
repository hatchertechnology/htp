import * as vue from 'vue'
const { ref, computed, defineComponent, h, createApp } = vue
// Synthetic data only. Mounts the real /forms page with stubbed Nuxt boundaries.
const SITE = '10000000-0000-0000-0000-000000000001'
const FORM = '10000000-0000-0000-0000-000000000002'
const HOST = '30000000-0000-0000-0000-000000000001'
const params = new URLSearchParams(location.search)
const flags = params.get('flags') ?? 'pilot'
const eligibleMode = params.get('eligible') ?? 'yes'
const siteMode = params.get('site') ?? 'yes'
const staticMode = params.get('static') !== '0'
const calls: string[] = [], queries: string[] = [], apiCalls: string[] = [], bodies: { method: string; path: string; body: any }[] = []
const form = { id: FORM, name: 'Cleaning Quote', form_key: 'cleaning_quote', active: true, fields: [{ key: 'name', label: 'Name', kind: 'text', required: true, max_length: 100 }] }
const rows = [{ id: '40000000-0000-0000-0000-000000000001', status: 'new', received_at: '2026-11-25T03:00:00Z', values: { name: '<script>unsafe</script>' } }]
const tableData: Record<string, any[]> = {
  website_form_hosts: [{ id: HOST, hostname: 'www.example.com', verified_at: '2026-01-01' }],
  website_forms: [form],
  website_form_responses: rows,
  website_form_origins: [{ form_id: FORM, host_id: HOST }],
}
const user = ref({ id: 'owner' })
const sites = ref(siteMode === 'none' ? [] : [{ id: SITE, fqdn: 'www.example.com' }])
const selectedId = ref(siteMode === 'none' ? '' : SITE)
const selected = computed(() => sites.value.find(site => site.id === selectedId.value) ?? null)
const contextReady = ref(true)
const workspace = {
  user, sites, selectedId, selected, contextReady, sitesTruncated: ref(false), loading: ref(false), error: ref(''),
  load: async () => undefined,
  selectWebsite: () => false,
}
function pageOf(items: any[]) { return { items, has_more: false } }
const supabase = {
  from(table: string) {
    queries.push(table)
    const query: any = { select: () => query, eq: () => query, in: () => query, order: () => query, range: () => query, then: (resolve: (value: unknown) => void) => resolve({ data: tableData[table] ?? [], error: null }) }
    return query
  },
  rpc: async (name: string) => { calls.push(name); return { data: true, error: null } },
  functions: { invoke: async () => ({ data: { ok: true }, error: null }) },
}
const transport = async (url: string, options: { method?: string; body?: any; headers?: Record<string, string> } = {}) => {
  const method = (options.method ?? 'GET').toUpperCase()
  const target = new URL(String(url), 'https://fixture.invalid')
  if (target.pathname === '/api/forms/pilot-eligibility') {
    if (eligibleMode === 'error') throw new Error('fixture auth failure')
    // A different site may report the notification capability, but not eligibility.
    return eligibleMode === 'foreign' ? { eligible: false, notifications_available: true } : { eligible: eligibleMode === 'yes' }
  }
  if (target.pathname === `/websites/${SITE}/forms/pilot-eligibility`) {
    if (eligibleMode === 'error') throw new Error('fixture auth failure')
    return { eligible: eligibleMode === 'yes', notifications_available: eligibleMode === 'foreign' }
  }
  if (!staticMode) throw new Error(`unexpected non-static request ${target.pathname}`)
  apiCalls.push(`${method} ${target.pathname}${target.search}`)
  if (options.body !== undefined) bodies.push({ method, path: target.pathname, body: JSON.parse(JSON.stringify(options.body)) })
  if (target.pathname === `/websites/${SITE}/forms/hosts`) return pageOf(tableData.website_form_hosts!)
  if (target.pathname === `/websites/${SITE}/forms` && method === 'GET') return pageOf(tableData.website_forms!)
  if (target.pathname === `/websites/${SITE}/forms/origins`) return pageOf(tableData.website_form_origins!)
  if (target.pathname === `/websites/${SITE}/forms/${FORM}/responses`) return pageOf(tableData.website_form_responses!)
  throw Object.assign(new Error(`fixture has no route for ${method} ${target.pathname}`), { data: { code: 'not_found' } })
}
Object.assign(globalThis, vue, {
  useWorkspace: () => workspace,
  useHead: () => undefined,
  useAuth: () => ({ user, ready: ref(true), accessToken: async () => 'fixture-token' }),
  useRuntimeConfig: () => ({ public: { supabaseUrl: 'https://example.test', apiBaseUrl: 'https://api.example.test', staticDashboard: staticMode, rolloutFormsPilot: flags === 'pilot', rolloutForms: flags === 'legacy', rolloutFormsResponses: true, rolloutFormsNotifications: false } }),
  useNuxtApp: () => ({ $supabase: supabase }),
  $fetch: transport,
  formsPageFixture: {
    apiCalls: () => [...apiCalls], calls: () => [...calls], queries: () => [...queries],
    setFlags: () => undefined,
  },
})
const { default: Page } = await import('../../app/pages/forms/index.vue')
const { default: WebsiteForms } = await import('../../app/components/WebsiteForms.vue')
const app = createApp(Page)
app.component('WebsiteForms', WebsiteForms)
app.component('UButton', defineComponent({ props: ['type', 'disabled', 'loading', 'color', 'variant', 'icon', 'block', 'size'], emits: ['click'], setup(props, { slots, emit }) { return () => h('button', { type: props.type ?? 'button', disabled: props.disabled, onClick: (event: Event) => emit('click', event) }, slots.default?.()) } }))
app.component('NuxtLink', defineComponent({ props: ['to'], setup(props, { slots }) { return () => h('a', { href: String(props.to) }, slots.default?.()) } }))
app.mount('#app')
