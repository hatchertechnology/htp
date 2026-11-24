import * as vue from 'vue'
const { ref, createApp, defineComponent, h } = vue
const params = new URLSearchParams(location.search)
const user = ref<{ id: string; is_anonymous: boolean } | null>({ id: 'fixture-owner', is_anonymous: false })
const calls: unknown[] = []
let fail = false
const supabase = {
  rpc: async (name: string, args: unknown) => { calls.push([name,args]); return fail ? { data: null, error: { message: 'failure' } } : { data: { host_id: 'fixture-host', txt_name: '_htp-verification.www.example.test', txt_value: 'htp-verification=' + 'a'.repeat(64) }, error: null } },
  functions: { invoke: async (name: string, args: unknown) => { calls.push([name,args]); return fail ? { data: null, error: {} } : { data: { ok: true }, error: null } } },
}
Object.assign(globalThis, vue, { verificationFixture: { calls, fail: (v: boolean) => { fail = v }, signOut: () => { user.value = null } }, useNuxtApp: () => ({ $supabase: supabase }), useAuth: () => ({ user, accessToken: async () => 'fixture-token' }), $fetch: async () => ({ eligible: params.get('eligible') !== 'no' }) })
const { default: Component } = await import('../../app/components/WebsiteFormVerification.vue')
const app = createApp(Component, { websiteId: 'fixture-site', fqdn: 'www.example.test' })
app.component('UButton', defineComponent({ inheritAttrs: false, setup(_, { slots, attrs }) { return () => h('button', attrs, slots.default?.()) } }))
app.mount('#app')
