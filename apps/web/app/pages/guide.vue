<script setup lang="ts">
const config = useRuntimeConfig()
const copy = useCopy()
useHead({ title: 'Hatch · Connection guide' })
const endpoints = computed(() => [
  { title: 'Public REST', method: 'GET', url: `${config.public.apiBaseUrl}/`, detail: 'Returns the hello world greeting. No authentication required.' },
  { title: 'Secured REST', method: 'GET', url: `${config.public.apiBaseUrl}/secured`, detail: 'Returns hello world secured for a signed-in user.' },
  { title: 'Public MCP', method: 'MCP', url: `${config.public.apiBaseUrl}/mcp`, detail: 'Streamable HTTP · hello_world tool' },
  { title: 'Secured MCP', method: 'MCP', url: `${config.public.apiBaseUrl}/mcp/secured`, detail: 'Streamable HTTP · hello_world_secured tool' },
])
const example = computed(() => `curl ${config.public.apiBaseUrl}/secured \\\n  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"`)
</script>

<template>
  <div class="guide-page"><div class="page-heading"><h1>One API. A few ways in.</h1><p>Everything you need to connect a browser, terminal, or MCP client.</p></div>
    <section class="guide-section" aria-labelledby="endpoints-heading"><h2 id="endpoints-heading">Your endpoints</h2><div class="endpoint-directory surface"><article v-for="endpoint in endpoints" :key="endpoint.url" class="directory-row"><span class="method">{{ endpoint.method }}</span><div><h3>{{ endpoint.title }}</h3><code>{{ endpoint.url }}</code><p>{{ endpoint.detail }}</p></div><UButton icon="i-lucide-copy" color="neutral" variant="ghost" :aria-label="`Copy ${endpoint.title} URL`" @click="copy(endpoint.url, 'Endpoint URL copied')" /></article></div></section>
    <section class="guide-section prose-section"><h2>Make a secured request</h2><p>Sign in with your Supabase account in the playground. The app includes your session token automatically when you choose <strong>Secured</strong>.</p><p>For your own client, send a signed-in user’s Supabase access token in the <code>Authorization</code> header on every request. A publishable API key is not a user token.</p><div class="guide-code"><pre><code>{{ example }}</code></pre><UButton icon="i-lucide-copy" aria-label="Copy curl example" color="neutral" variant="ghost" @click="copy(example, 'Example copied')" /></div></section>
    <section class="guide-section prose-section"><h2>Connect an MCP client</h2><p>Choose Streamable HTTP and paste one of the MCP URLs above. For the secured endpoint, configure <code>Authorization: Bearer &lt;access_token&gt;</code> as a request header.</p><p>Connections are stateless. The protected endpoint checks authentication for initialization, discovery, and every tool call. Use an existing Supabase session token; automatic OAuth login is not provided.</p><NuxtLink to="/mcp" class="text-link">Try the MCP playground<UIcon name="i-lucide-arrow-right" /></NuxtLink></section>
    <section class="guide-section prose-section"><h2>Your Supabase project</h2><p>Email confirmation is required when you create an account. Once you confirm, return to the playground and sign in. Sessions refresh automatically while you use the app.</p><UButton to="https://supabase.com/dashboard/project/raxuvdbdfmmtpqjcafcq" target="_blank" rel="noopener noreferrer" color="neutral" variant="outline" trailing-icon="i-lucide-external-link">Open Supabase project</UButton></section>
  </div>
</template>
