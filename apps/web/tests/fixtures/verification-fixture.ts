import * as vue from 'vue'
const { ref, createApp, defineComponent, h } = vue
const params = new URLSearchParams(location.search)
const user = ref<{ id: string; is_anonymous: boolean } | null>({ id: 'fixture-owner', is_anonymous: false })
const calls: unknown[] = []
let fail = false
let held = params.get('hold') ?? '', release: (() => void) | null = null
async function pause(name: string) { if (held === name) await new Promise<void>(resolve => { release = resolve }) }
const supabase = {
  rpc: (name: string, args: unknown) => ({ retry: async (enabled: boolean) => { if (enabled !== false) throw Error('retry enabled'); calls.push([name,args]); await pause(name); return fail ? { data: null, error: { message: 'failure' } } : { data: { host_id: 'fixture-host', txt_name: '_htp-verification.www.example.test', txt_value: 'htp-verification=' + 'a'.repeat(64) }, error: null } } }),
  functions: { invoke: async (name: string, args: unknown) => { calls.push([name,args]); await pause(name); return fail ? { data: null, error: {} } : { data: { ok: true }, error: null } } },
}
Object.assign(globalThis, vue, { verificationFixture: { calls, fail: (v: boolean) => { fail = v }, signOut: () => { user.value = null }, signIn: (id: string) => { user.value = { id, is_anonymous: false } }, hold: (name: string) => { held = name }, release: () => { held = ''; release?.(); release = null }, waiting: () => !!release }, useNuxtApp: () => ({ $supabase: supabase }), useAuth: () => ({ user, accessToken: async () => 'fixture-token' }), $fetch: async () => { await pause('eligibility'); return { eligible: params.get('eligible') !== 'no' } } })
const { default: Component } = await import('../../app/components/WebsiteFormVerification.vue')
const app = createApp(Component, { websiteId: 'fixture-site', fqdn: 'www.example.test' })
app.component('UButton', defineComponent({ inheritAttrs: false, setup(_, { slots, attrs }) { return () => h('button', attrs, slots.default?.()) } }))
app.mount('#app')
