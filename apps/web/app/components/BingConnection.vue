<script setup lang="ts">
const ws = useWorkspace()
const { bing, bingReady, bingError } = ws
const busy = ref(false)
const error = ref('')
const route = useRoute()
const outcome = computed(() => ({ invalid_state: 'The Bing connection request expired. Try again.', denied: 'Bing access was not approved.', failed: 'Bing could not complete the connection. Try again.', connected: 'Bing connected. Daily collection will start shortly.' }[String(route.query.bing)] || ''))
async function connect() {
  busy.value = true; error.value = ''
  try { const result = await ws.request<{ url: string }>('/api/bing/connect', { method: 'POST' }); window.location.assign(result.url) }
  catch (cause) { error.value = failureMessage(cause); busy.value = false }
}
async function disconnect() {
  busy.value = true; error.value = ''
  try { await ws.request('/api/bing/connection', { method: 'DELETE' }); await ws.checkBing() }
  catch (cause) { error.value = failureMessage(cause) }
  finally { busy.value = false }
}
</script>
<template>
  <section class="connection-settings surface bing-connection" aria-labelledby="bing-connection-heading">
    <div class="settings-title"><UIcon name="i-lucide-search" /><h2 id="bing-connection-heading">Bing Webmaster Tools</h2></div>
    <p>Connect the Bing Webmaster account with verified access to your websites for search traffic, crawl health, and sitemap reports.</p>
    <div class="connection-state"><span :class="['connection-dot', { connected: bing.connected && !bing.reauthorizationRequired }]" />{{ !ws.user.value ? 'Sign in first' : !bingReady ? 'Checking connection…' : bingError ? 'Connection check unavailable' : bing.reauthorizationRequired ? 'Reconnect to resume updates' : bing.connected ? 'Connected for daily updates' : 'Not connected' }}</div>
    <p v-if="error || bingError" class="form-error" role="alert">{{ error || bingError }} <button v-if="bingError" @click="ws.checkBing">Retry</button></p>
    <p v-if="outcome" class="form-notice" role="status">{{ outcome }}</p>
    <p v-if="!bing.configured" class="form-notice">Bing connections are not configured yet. Contact the workspace administrator.</p>
    <UButton v-if="!bing.connected || bing.reauthorizationRequired" :loading="busy" :disabled="!ws.user.value || !bingReady || !bing.configured || !!bingError" icon="i-lucide-link" @click="connect">{{ bing.reauthorizationRequired ? 'Reconnect Bing' : 'Connect Bing' }}</UButton>
    <UButton v-if="bing.connected" :loading="busy" color="neutral" variant="outline" @click="disconnect">Disconnect Bing</UButton>
    <div class="connection-notes"><p>Read-only access. Reports collect daily, including while you are signed out. Bing may update query and page statistics weekly.</p><p>Hatch matches verified root properties to the exact website hostname and prefers HTTPS. Add and verify each website in Bing Webmaster Tools first.</p><p>Your connection is encrypted. Disconnecting stops updates across all devices and keeps saved reports available.</p></div>
  </section>
</template>
<style scoped>.bing-connection { margin-top: 1.5rem; }</style>
