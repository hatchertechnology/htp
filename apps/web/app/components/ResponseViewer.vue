<script setup lang="ts">
import type { PlaygroundResponse } from '../../shared/types/api'
const props = defineProps<{ response: PlaygroundResponse | null; loading: boolean; error: string }>()
const copy = useCopy()
const formatted = computed(() => props.response ? JSON.stringify(props.response.body, null, 2) : '')
const lines = computed(() => formatted.value.split('\n'))
const success = computed(() => props.response && props.response.status >= 200 && props.response.status < 300 && !(props.response.body as { error?: unknown } | null)?.error)

function tokens(line: string) {
  return line.split(/("(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*")/g).filter(Boolean).map(text => ({
    text, kind: text.trim().endsWith(':') ? 'key' : text.startsWith('"') ? 'string' : 'punctuation',
  }))
}
</script>

<template>
  <section class="response-panel" :aria-busy="loading" aria-labelledby="response-heading">
    <div class="response-header">
      <h2 id="response-heading">Response</h2>
      <span v-if="response && !loading" :class="['response-status', { 'is-error': !success }]" role="status"><span class="status-dot" />{{ response.status }} {{ response.statusText }}<span class="response-timing">{{ response.durationMs }} ms</span></span>
      <span v-else class="response-status muted" role="status">{{ loading ? 'Sending request…' : 'Ready when you are' }}</span>
      <div class="response-actions"><span v-if="response" class="response-format">JSON</span><UButton color="neutral" variant="ghost" icon="i-lucide-copy" aria-label="Copy response" :disabled="!response || loading" @click="copy(formatted, 'Response copied')" /></div>
    </div>
    <div class="response-body" aria-live="polite" aria-atomic="true">
      <div v-if="loading" class="response-empty"><UIcon name="i-lucide-loader-circle" class="request-spinner" /><p>Waiting for your API<span>It may take a moment to wake up.</span></p></div>
      <div v-else-if="error" class="response-empty response-error" role="alert"><UIcon name="i-lucide-circle-alert" /><p>{{ error }}<span>Try sending the request again.</span></p></div>
      <pre v-else-if="response" class="json-code" aria-label="JSON response"><code><span v-for="(line, index) in lines" :key="index" class="code-row"><span class="line-number" aria-hidden="true">{{ index + 1 }}</span><span class="code-content"><span v-for="(token, i) in tokens(line)" :key="i" :class="`syntax-${token.kind}`">{{ token.text }}</span></span></span></code></pre>
      <div v-else class="response-empty"><UIcon name="i-lucide-braces" /><p>Your response will appear here.<span>Send a request to get started.</span></p></div>
    </div>
    <p class="response-caption">Responses come directly from your API.</p>
  </section>
</template>
