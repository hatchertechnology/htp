import * as vue from 'vue'
import { useWorkspace, useReportRange, failureMessage } from '../../app/composables/useWorkspace'
import { useRepositoryHistory } from '../../app/composables/useRepositoryHistory'
import { useRepositoryIssues } from '../../app/composables/useRepositoryIssues'
const { ref, h, createApp, defineComponent } = vue
const id = '00000000-0000-0000-0000-000000000001'
const calls: {url: string; options: any}[] = []
const states = new Map()
const user = ref<{id: string} | null>({id: 'fixture-owner'})
const mode = new URLSearchParams(location.search).get('static') === '1'
let enabled = true
const repository_url = 'https://github.com/example/site'
Object.assign(globalThis, vue, {
  useWorkspace, useReportRange, failureMessage, useRepositoryHistory, useRepositoryIssues,
  useAuth: () => ({user, ready: ref(true), accessToken: async () => user.value ? 'fixture-token' : null}),
  useRuntimeConfig: () => ({public: {staticDashboard: mode, apiBaseUrl: 'https://api.example.test'}}),
  useState: (key: string, init: () => unknown) => { if (!states.has(key)) states.set(key, ref(init())); return states.get(key) },
  $fetch: async (url: string, options: any) => {
    calls.push({url, options})
    if (url.includes('connection')) return {connected: false, configured: true}
    if (url.includes('/repository/issues')) {
      const number = options.query.page
      return {repository_url, issues: [{number, title: `Fixture ${options.query.state} issue ${number}`, state: options.query.state === 'all' ? 'open' : options.query.state, url: `${repository_url}/issues/${number}`, updated_at: '2026-10-01T00:00:00Z'}], has_more: number === 1}
    }
    if (url.includes('/repository')) {
      if (options.method === 'PUT') { enabled = options.body.repository_url !== null && options.body.enabled; return {repository_url, enabled} }
      const number = options.query.before_id ? 1 : 2
      return {fqdn: 'example.test', repository: {repository_url, enabled, branch: null}, commits: [{id: number, sha: `abcdef${number}`, message: `Fixture commit ${number}`, author: 'Fixture', repository_url, branch: null, committed_at: '2026-10-01T00:00:00Z', observed_at: '2026-10-02T00:00:00Z'}], has_more: number === 2}
    }
    return {items: [{id, fqdn: 'example.test'}], has_more: false}
  },
  repositoryFixture: {calls, signOut: () => {user.value = null}},
})
const {default: Settings} = await import('../../app/components/RepositorySettings.vue')
const {default: History} = await import('../../app/components/RepositoryHistory.vue')
const {default: Issues} = await import('../../app/components/RepositoryIssues.vue')
const app = createApp(defineComponent({setup() {
  const ws = useWorkspace()
  return () => h('main', [h('p', `Selected: ${ws.selected.value?.fqdn ?? ''}`), h(Settings, {websiteId: id, fqdn: 'example.test'}), h(History), h(Issues)])
}}))
app.component('UButton', defineComponent({setup(_, {slots}) {return () => h('button', slots.default?.())}}))
app.component('UFormField', defineComponent({setup(_, {slots}) {return () => h('label', slots.default?.())}}))
app.component('UInput', defineComponent({props: ['modelValue'], emits: ['update:modelValue'], setup(props, {emit}) {return () => h('input', {value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)})}}))
app.component('NuxtLink', defineComponent({setup(_, {slots}) {return () => h('a', slots.default?.())}}))
app.mount('#app')
