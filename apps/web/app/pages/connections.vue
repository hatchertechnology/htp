<script setup lang="ts">
useHead({ title: 'Hatch · Connections' })
const workspace = useWorkspace()
const { user, google, connectionReady } = workspace
const route = useRoute()
const busy = ref(false)
const error = ref('')
const outcome = computed(() => ({ invalid_state: 'The connection request expired. Try connecting again.', denied: 'Google access was not approved. You can try again.', missing_scope: 'No supported Google access was granted. Connect again and allow the services you want to use.', failed: 'Google could not complete the connection. Try again.' }[String(route.query.google)] || ''))
async function connect() {
  busy.value = true; error.value = ''
  try { const result = await workspace.request<{url:string}>('/api/google/connect', { method: 'POST' }); window.location.assign(result.url) }
  catch (cause) { error.value = failureMessage(cause); busy.value = false }
}
async function disconnect() {
  busy.value = true; error.value = ''
  try { await workspace.request('/api/google/connection', { method: 'DELETE' }); await workspace.checkGoogle() }
  catch (cause) { error.value = failureMessage(cause) }
  finally { busy.value = false }
}
</script>
<template>
  <div class="page-heading"><h1>Connections</h1><p>Your account and the services behind your website reports.</p></div>
  <div class="connections-layout">
    <section class="connection-settings surface" aria-labelledby="google-heading">
      <div class="settings-title"><UIcon name="i-lucide-chart-no-axes-combined" /><h2 id="google-heading">Google services</h2></div>
      <p>Connect the Google account that has access to your websites. Review Search Console performance, inspect URLs, and read Google Analytics reports in one workspace.</p>
      <div class="connection-state"><span :class="['connection-dot', {connected: google.connected && !google.reauthorizationRequired}]" />{{ !user ? 'Sign in first' : !connectionReady ? 'Checking connection…' : google.reauthorizationRequired ? 'Reconnect to resume updates' : google.connected ? 'Connected for background updates' : 'Not connected' }}</div>
      <p v-if="outcome || error" class="form-error" role="alert">{{ error || outcome }}</p>
      <p v-if="!google.configured" class="form-notice">Google connections are not configured yet. Contact the workspace administrator.</p>
      <UButton v-if="!google.connected" icon="i-lucide-link" :loading="busy" :disabled="!user || !connectionReady || !google.configured" @click="connect">Connect Google</UButton>
      <template v-else><UButton v-if="google.reauthorizationRequired || !google.analytics || !google.search" :loading="busy" @click="connect">{{ google.reauthorizationRequired ? 'Reconnect Google' : 'Extend Google access' }}</UButton> <UButton color="neutral" variant="outline" :loading="busy" @click="disconnect">Disconnect Google</UButton></template>
      <dl v-if="google.connected" class="service-access"><div><dt>Google Analytics</dt><dd>{{ google.analytics ? 'Authorized · read-only' : 'Reconnect to authorize' }}</dd></div><div><dt>Search Console &amp; URL Inspection</dt><dd>{{ google.search ? 'Authorized · read-only' : 'Reconnect to authorize' }}</dd></div></dl>
      <div class="connection-notes"><p>Analytics and Search Console use read-only access. Reports are saved and refreshed hourly, including while you are signed out.</p><p>Enable the Google Analytics Data API and Google Search Console API in your OAuth project. The URL Inspection API is part of Search Console. Your Google account must have access to each property.</p><p>Your Google connection is stored encrypted for your account. Disconnecting stops updates on all devices; saved reports remain. You may need to reconnect while the Google app is in testing.</p><p>Google access is currently available to approved test users.</p></div>
      <NuxtLink to="/websites" class="settings-link">Link a GA4 property to a website <UIcon name="i-lucide-arrow-right" /></NuxtLink>
    </section>
    <AccountPanel />
  </div>
</template>
