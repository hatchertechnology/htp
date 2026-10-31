<script setup lang="ts">
import type { OAuthGrant } from '@supabase/supabase-js'
const { user, ready } = useAuth()
const { $supabase } = useNuxtApp()
const grants = ref<OAuthGrant[]>([])
const loading = ref(false)
const busy = ref<string | null>(null)
const error = ref('')
let generation = 0
async function load() {
  const current = ++generation
  grants.value = []; error.value = ''; loading.value = false
  if (!ready.value || !user.value) return
  loading.value = true
  try {
    const result = await $supabase.auth.oauth.listGrants()
    if (current !== generation) return
    if (result.error) throw result.error
    grants.value = result.data || []
  } catch { if (current === generation) error.value = 'Could not load authorized apps. Try again.' }
  finally { if (current === generation) loading.value = false }
}
watch([() => ready.value, () => user.value?.id], load, { immediate: true })
onBeforeUnmount(() => { generation++ })
async function revoke(clientId: string) {
  if (busy.value) return
  const current = generation
  busy.value = clientId; error.value = ''
  try {
    const result = await $supabase.auth.oauth.revokeGrant({ clientId })
    if (current !== generation) return
    if (result.error) throw result.error
    grants.value = grants.value.filter(grant => grant.client.id !== clientId)
  } catch { if (current === generation) error.value = 'Could not revoke this app. Try again.' }
  finally { busy.value = null }
}
</script>
<template>
  <section class="connection-settings surface authorized-agents" aria-labelledby="agents-heading">
    <div class="settings-title"><UIcon name="i-lucide-bot" /><h2 id="agents-heading">Authorized apps</h2></div>
    <p>Connect an agent using <code>https://htp-api-kerry-hatcher.fly.dev/mcp/secured</code> in its MCP settings, then approve access in your browser.</p>
    <p v-if="!user">Sign in to review the apps connected to your account.</p>
    <p v-else-if="loading" role="status">Loading authorized apps…</p>
    <p v-else-if="!grants.length && !error">No apps have been authorized.</p>
    <ul v-if="grants.length" class="agent-grants"><li v-for="grant in grants" :key="grant.client.id"><div><strong>{{ grant.client.name || 'Unnamed app' }}</strong><p>{{ grant.scopes.join(', ') || 'Account access' }}</p></div><UButton color="neutral" variant="outline" :loading="busy === grant.client.id" :disabled="!!busy" @click="revoke(grant.client.id)">Revoke access</UButton></li></ul>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <UButton v-if="error" color="neutral" variant="outline" @click="load">Try again</UButton>
    <p v-if="grants.length" class="connection-notes">Revoking stops token renewal. Issued access tokens may remain usable until they expire.</p>
  </section>
</template>
<style scoped>
.authorized-agents { margin-top: 24px; }
.authorized-agents code { overflow-wrap: anywhere; }
.agent-grants { list-style: none; padding: 0; margin: 20px 0; }
.agent-grants li { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 0; border-top: 1px solid var(--border); }
.agent-grants strong { overflow-wrap: anywhere; }
</style>
