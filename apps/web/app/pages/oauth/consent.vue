<script setup lang="ts">
import type { OAuthAuthorizationDetails } from '@supabase/supabase-js'
import { authorizationId, consentRedirect, scopeDescription } from '#shared/utils/oauth'
useHead({ title: 'Hatch · Approve app access', meta: [{ name: 'robots', content: 'noindex, nofollow' }] })
const route = useRoute()
const { user, ready } = useAuth()
const { $supabase } = useNuxtApp()
const id = computed(() => authorizationId(route.query.authorization_id))
const details = ref<OAuthAuthorizationDetails | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
let generation = 0
const scopes = computed(() => details.value?.scope.split(' ').filter(Boolean) || [])

async function load() {
  const current = ++generation
  details.value = null; error.value = ''; loading.value = false; busy.value = false
  if (!ready.value || !user.value || !id.value) return
  loading.value = true
  try {
    const result = await $supabase.auth.oauth.getAuthorizationDetails(id.value)
    if (current !== generation) return
    if (result.error || !result.data) throw new Error('This authorization request expired or could not be loaded. Start the connection again from your agent.')
    if ('redirect_url' in result.data) { window.location.assign(consentRedirect(result.data.redirect_url)); return }
    if (result.data.user.id !== user.value?.id) throw new Error('The account changed. Start the connection again from your agent.')
    details.value = result.data
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : 'Could not load this request. Try again.'
  } finally { if (current === generation) loading.value = false }
}
watch([() => ready.value, () => user.value?.id, id], load, { immediate: true })
onBeforeUnmount(() => { generation++ })

async function decide(approve: boolean) {
  if (busy.value || !id.value || !details.value) return
  const current = generation
  busy.value = true; error.value = ''
  try {
    const result = approve
      ? await $supabase.auth.oauth.approveAuthorization(id.value, { skipBrowserRedirect: true })
      : await $supabase.auth.oauth.denyAuthorization(id.value, { skipBrowserRedirect: true })
    if (current !== generation) return
    if (result.error || !result.data) throw new Error('The request could not be completed. Start the connection again from your agent.')
    window.location.assign(consentRedirect(result.data.redirect_url))
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : 'Could not complete authorization. Try again.'
  } finally { if (current === generation) busy.value = false }
}
</script>

<template>
  <div class="page-heading"><h1>Approve app access</h1><p>Connect an AI agent to your Hatch account.</p></div>
  <div class="connections-layout">
    <section class="connection-settings surface oauth-consent" aria-labelledby="consent-heading">
      <h2 id="consent-heading">{{ details ? `${details.client.name || 'This app'} wants access` : 'Review this connection' }}</h2>
      <p v-if="!id" class="form-error" role="alert">This page needs a valid authorization request. Start the connection from your agent’s MCP settings.</p>
      <p v-else-if="!ready || loading" role="status">{{ loading ? 'Loading the app’s request…' : 'Checking your account…' }}</p>
      <p v-else-if="!user">Sign in to review the app and approve or deny its access. Your connection request will stay open here.</p>
      <template v-if="details">
        <p>Only approve apps you recognize and trust. This app will act as <strong>{{ user?.email }}</strong>.</p>
        <ul class="oauth-permissions">
          <li>Read saved reports, complete SEO audits, profile changes, and repository history for your websites.</li>
          <li>Add, rename or permanently delete website records and saved evidence; manage GA4, Business Profile and repository settings using your account’s existing permissions.</li>
          <li>Request background reports, import technical SEO audits, inspect indexed URLs, and view or disconnect your Google and Bing connections. Provider credentials stay on the HTP server.</li>
          <li v-for="scope in scopes" :key="scope">{{ scopeDescription(scope) }}</li>
        </ul>
        <dl class="service-access"><div><dt>App ID</dt><dd>{{ details.client.id }}</dd></div><div><dt>Return address</dt><dd>{{ details.redirect_uri }}</dd></div></dl>
        <p>You can revoke this app under <NuxtLink to="/connections">Connections</NuxtLink>. Revocation stops token renewal; an issued access token may remain usable until it expires.</p>
        <div class="oauth-actions"><UButton size="lg" :loading="busy" :disabled="busy" @click="decide(true)">Approve access</UButton><UButton size="lg" color="neutral" variant="outline" :disabled="busy" @click="decide(false)">Deny</UButton></div>
      </template>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <UButton v-if="error && user && id && !details" color="neutral" variant="outline" @click="load">Try again</UButton>
    </section>
    <AccountPanel />
  </div>
</template>

<style scoped>
.oauth-consent h2 { margin-bottom: 16px; }
.oauth-consent p { max-width: 65ch; }
.oauth-permissions { list-style: disc; padding-left: 22px; margin: 20px 0; }
.oauth-permissions li + li { margin-top: 10px; }
.oauth-consent dd { overflow-wrap: anywhere; }
.oauth-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
</style>
