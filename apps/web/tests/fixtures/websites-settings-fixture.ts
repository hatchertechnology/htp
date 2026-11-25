import * as vue from 'vue'
import { useWebsites } from '../../app/composables/useWebsites'
const { ref, computed, h, createApp, defineComponent } = vue

const ONE = '00000000-0000-0000-0000-000000000001'
const TWO = '00000000-0000-0000-0000-000000000002'
const NEW = '00000000-0000-0000-0000-000000000009'
const staticMode = new URLSearchParams(location.search).get('static') === '1'
const calls: { url: string; method: string; body?: unknown; headers?: Record<string, string> }[] = []
const toasts: { title?: string; description?: string }[] = []
let holdMethod: string | null = null
let gate: Promise<void> | null = null
let releaseGate: (() => void) | null = null
let failMethod: string | null = null
const server = { sites: [
  { id: ONE, fqdn: 'one.example.com', ga4_property_id: '111111111' },
  { id: TWO, fqdn: 'two.example.com', ga4_property_id: null },
] as { id: string; fqdn: string; ga4_property_id?: string | null }[] }

function copy() { return server.sites.map(site => ({ ...site })) }
function find(id: string) { return server.sites.find(site => site.id === id) }

const sites = ref(copy())
const selectedId = ref(ONE)
const contextReady = ref(true)
const sitesTruncated = ref(false)
const loading = ref(false)
const error = ref('')
const selected = computed(() => sites.value.find(site => site.id === selectedId.value) ?? null)

function reload() {
  sites.value = copy()
  if (!sites.value.some(site => site.id === selectedId.value)) selectedId.value = sites.value[0]?.id ?? ''
  return sites.value
}

let failLoad = false
async function load() {
  if (failLoad) { failLoad = false; error.value = 'Fixture load failed'; return sites.value }
  error.value = ''
  return reload()
}

async function transport(url: string, options: { method?: string; body?: { fqdn?: string; property_id?: string | null } } = {}) {
  const method = options.method ?? 'GET'
  calls.push({ url, method, body: options.body, headers: { Authorization: 'Bearer fixture-token' } })
  if (holdMethod === method) {
    holdMethod = null
    const waiting = gate
    gate = null
    await waiting
  }
  if (failMethod === method) {
    failMethod = null
    throw { data: { error: 'Fixture write failed' } }
  }
  if (method === 'POST') {
    const created = { id: NEW, fqdn: options.body?.fqdn ?? '', ga4_property_id: null }
    server.sites = [...server.sites, created]
    return { ...created }
  }
  if (method === 'PATCH') {
    const site = find(url.slice(url.lastIndexOf('/') + 1))
    if (site) site.fqdn = options.body?.fqdn ?? site.fqdn
    return site ? { ...site } : null
  }
  if (method === 'PUT' && url.includes('/analytics/property')) {
    const site = find(url.split('/websites/')[1]!.split('/')[0]!)
    if (site) site.ga4_property_id = options.body?.property_id ?? null
    return site ? { ...site } : null
  }
  if (method === 'DELETE') {
    server.sites = server.sites.filter(site => site.id !== url.slice(url.lastIndexOf('/') + 1))
    return null
  }
  return null
}

const fixtureUser = ref<{ id: string } | null>({ id: 'fixture-owner' })
const workspace = {
  user: fixtureUser, sites, selectedId, selected, contextReady, sitesTruncated, loading, error,
  load: () => load(),
  selectWebsite: (id: string) => { if (!sites.value.some(site => site.id === id)) return false; selectedId.value = id; return true },
  request: (url: string, options: Record<string, unknown> = {}) => transport(url, options as never),
}

Object.assign(globalThis, vue, {
  useWebsites,
  useWorkspace: () => workspace,
  useHead: () => undefined,
  useToast: () => ({ add: (toast: { title?: string; description?: string }) => { toasts.push(toast) } }),
  useAuth: () => ({ user: fixtureUser, ready: ref(true), accessToken: async () => 'fixture-token' }),
  useRuntimeConfig: () => ({ public: { staticDashboard: staticMode, apiBaseUrl: 'https://api.example.test' } }),
  $fetch: transport,
  failureMessage: (cause: unknown) => (cause as { message?: string })?.message ?? 'Something went wrong. Please try again.',
  websitesFixture: {
    calls,
    toasts,
    select: (id: string) => { selectedId.value = id },
    server: () => copy(),
    holdNext: (method: string) => { holdMethod = method; gate = new Promise(resolve => { releaseGate = resolve }) },
    failNext: (method: string) => { failMethod = method },
    failNextLoad: () => { failLoad = true },
    release: () => { releaseGate?.(); releaseGate = null },
  },
})

const { default: Page } = await import('../../app/pages/websites.vue')
const app = createApp(Page)
app.component('UButton', defineComponent({
  props: ['type', 'disabled', 'loading', 'color', 'variant', 'icon', 'block', 'size'],
  emits: ['click'],
  setup(props, { slots, emit }) {
    return () => h('button', { type: props.type ?? 'button', disabled: props.disabled, onClick: (event: Event) => emit('click', event) }, slots.default?.())
  },
}))
app.component('UFormField', defineComponent({
  props: ['label', 'name', 'error', 'help'],
  setup(props, { slots }) {
    return () => h('div', { class: 'fixture-field' }, [
      props.label ? h('label', [props.label, slots.default?.()]) : slots.default?.(),
      props.error ? h('p', { class: 'form-error', role: 'alert' }, props.error) : null,
      props.help ? h('p', { class: 'fixture-help' }, props.help) : null,
    ])
  },
}))
app.component('UInput', defineComponent({
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () => h('input', { ...attrs, value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) })
  },
}))
app.component('UIcon', defineComponent({ props: ['name'], setup() { return () => null } }))
app.component('NuxtLink', defineComponent({ props: ['to'], setup(props, { slots }) { return () => h('a', { href: String(props.to), 'data-to': String(props.to) }, slots.default?.()) } }))
app.component('RepositorySettings', defineComponent({
  props: ['websiteId', 'fqdn'],
  setup(props) { return () => h('div', { 'data-testid': 'repository-settings', 'data-website-id': props.websiteId, 'data-fqdn': props.fqdn }, 'GitHub repository settings') },
}))
app.mount('#app')
