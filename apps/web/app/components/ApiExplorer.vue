<script setup lang="ts">
import type { Access, Operation, PlaygroundResponse, Transport } from '../../shared/types/api'
const props = defineProps<{ transport: Transport }>()
const config = useRuntimeConfig()
const auth = useAuth()
const access = ref<Access>('public')
const operation = ref<Operation>('call')
const response = ref<PlaygroundResponse | null>(null)
const loading = ref(false)
const error = ref('')
let controller: AbortController | null = null
let generation = 0
const secured = computed(() => access.value === 'secured')
const path = computed(() => props.transport === 'rest' ? secured.value ? '/secured' : '/' : secured.value ? '/mcp/secured' : '/mcp')
const toolName = computed(() => secured.value ? 'hello_world_secured' : 'hello_world')
const host = computed(() => config.public.apiBaseUrl.replace(/^https?:\/\//, ''))

function focusSession() {
  const panel = document.getElementById('your-session')
  panel?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' })
  document.getElementById('account-email')?.focus({ preventScroll: true })
}

function clear() {
  generation++
  controller?.abort()
  loading.value = false
  response.value = null
  error.value = ''
}
watch([access, operation, () => props.transport, () => auth.user.value?.id], clear)
onBeforeUnmount(clear)

async function sendRequest() {
  if (loading.value) return
  if (secured.value && !auth.user.value) return focusSession()
  controller?.abort()
  controller = new AbortController()
  const current = ++generation
  loading.value = true
  error.value = ''
  try {
    const token = secured.value ? await auth.accessToken() : null
    if (current !== generation) return
    if (secured.value && !token) {
      focusSession()
      error.value = 'Your session has ended. Sign in again to send this request.'
      return
    }
    const result = await $fetch.raw<PlaygroundResponse>('/api/playground', {
      method: 'POST', body: { transport: props.transport, access: access.value, operation: operation.value },
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal, timeout: 50_000, retry: 0, ignoreResponseError: true,
    })
    if (current !== generation) return
    if (result._data && typeof result._data.status === 'number') response.value = result._data
    else error.value = result.status === 502 ? 'The API is taking longer than expected.' : 'The request could not be completed.'
  } catch (cause) {
    if (current === generation && !(cause instanceof Error && cause.name === 'AbortError')) error.value = 'Could not connect to the API. Check your connection.'
  } finally {
    if (current === generation) loading.value = false
  }
}
onMounted(sendRequest)
</script>

<template>
  <div class="explorer-layout">
    <section class="request-panel surface" aria-labelledby="request-heading">
      <div class="request-builder">
        <div class="request-heading"><h2 id="request-heading">Request</h2><div class="access-switch" role="group" aria-label="Endpoint access">
          <UButton label="Public" icon="i-lucide-globe" :variant="access === 'public' ? 'soft' : 'ghost'" :color="access === 'public' ? 'primary' : 'neutral'" :aria-pressed="access === 'public'" @click="access = 'public'" />
          <UButton label="Secured" icon="i-lucide-lock-keyhole" :variant="access === 'secured' ? 'soft' : 'ghost'" :color="access === 'secured' ? 'primary' : 'neutral'" :aria-pressed="access === 'secured'" @click="access = 'secured'" />
        </div></div>
        <div class="endpoint-row"><span class="method">{{ transport === 'rest' ? 'GET' : 'POST' }}</span><div class="endpoint-address"><code>{{ path }}</code><span>{{ host }}</span></div></div>
        <div v-if="transport === 'mcp'" class="mcp-operation"><label for="mcp-operation">Operation</label><select id="mcp-operation" v-model="operation"><option value="call">Call {{ toolName }}</option><option value="list">List available tools</option></select></div>
        <div class="request-send-row"><p>{{ secured ? auth.user.value ? 'Your Supabase session is included securely.' : 'A signed-in Supabase session is required.' : 'No sign-in required. A good place to start.' }}</p><UButton size="lg" :loading="loading" :disabled="secured && !auth.ready.value" :trailing-icon="secured && !auth.user.value ? 'i-lucide-lock-keyhole' : 'i-lucide-arrow-right'" @click="sendRequest">{{ secured && !auth.user.value ? 'Sign in to send' : 'Send request' }}</UButton></div>
      </div>
      <ResponseViewer :response="response" :loading="loading" :error="error" />
    </section>
    <AccountPanel />
  </div>
</template>
