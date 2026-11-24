<script setup lang="ts">
const props = defineProps<{ websiteId: string; fqdn: string }>()
const { $supabase } = useNuxtApp()
const auth = useAuth()
const eligible = ref(false), expanded = ref(false), busy = ref(false), error = ref(''), notice = ref('')
const creationUncertain = ref(false)
const challenge = ref<{ host_id: string; txt_name: string; txt_value: string; expires: number } | null>(null)
let generation = 0
function markerKey(owner: string, site: string) { return `forms-verification-pending:${owner}:${site}` }
watch(() => [auth.user.value?.id, auth.user.value?.is_anonymous, props.websiteId, props.fqdn] as const, async ([owner, anonymous, websiteId]) => {
  const current = ++generation
  eligible.value = false; expanded.value = false; challenge.value = null; creationUncertain.value = false; error.value = ''; notice.value = ''
  if (!owner || anonymous !== false) return
  try {
    creationUncertain.value = localStorage.getItem(markerKey(owner, websiteId)) !== null
    const token = await auth.accessToken()
    if (!token) return
    const result = await $fetch<{ eligible: boolean }>('/api/forms/pilot-eligibility', { query: { website_id: websiteId }, headers: { Authorization: `Bearer ${token}` }, retry: 0 })
    if (generation === current) eligible.value = result.eligible === true
  } catch { /* Visibility fails closed. */ }
}, { immediate: true })
async function begin() {
  if (!eligible.value || busy.value || challenge.value || creationUncertain.value) return
  const current = generation, started = Date.now(), owner = auth.user.value?.id
  if (!owner) return
  try { localStorage.setItem(markerKey(owner, props.websiteId), 'pending') } catch { creationUncertain.value = true; error.value = 'Could not safely start verification. Please contact support.'; return }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const { data, error: err } = await $supabase.rpc('begin_form_host_verification', { p_website_id: props.websiteId, p_hostname: props.fqdn }).retry(false)
    if (err || !data?.host_id || !data?.txt_name || !data?.txt_value) throw new Error('Could not create a DNS challenge. Please try again later.')
    if (current === generation) challenge.value = { ...data, expires: started + 24 * 60 * 60 * 1000 }
  } catch { if (current === generation) { creationUncertain.value = true; error.value = 'The challenge request may have succeeded, but its value was not received. Do not create another challenge until this is resolved with support.' } }
  finally { busy.value = false }
}
async function verify() {
  const item = challenge.value
  if (!eligible.value || busy.value || !item) return
  if (Date.now() >= item.expires) { error.value = 'This challenge may have expired. Contact support before requesting a replacement.'; challenge.value = null; creationUncertain.value = true; return }
  const current = generation
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const token = item.txt_value.slice('htp-verification='.length)
    const { data, error: err } = await $supabase.functions.invoke('form-verify', { body: { host_id: item.host_id, token } })
    if (err || !data?.ok) throw new Error('verification failed')
    if (current === generation) { localStorage.removeItem(markerKey(auth.user.value!.id, props.websiteId)); challenge.value = null; notice.value = 'Domain verified.' }
  } catch { if (current === generation) error.value = 'Could not verify the DNS record yet. Check the value and try again. Challenges expire after 24 hours.' }
  finally { busy.value = false }
}
</script>

<template>
  <section v-if="eligible" class="verification" :aria-label="`Domain verification for ${fqdn}`">
    <UButton color="neutral" variant="ghost" @click="expanded = !expanded">{{ expanded ? 'Close domain verification' : 'Verify domain' }}</UButton>
    <div v-show="expanded" class="verification-content">
      <h3>Verify {{ fqdn }}</h3>
      <p v-if="creationUncertain && !error" role="alert">A previous challenge may still be active. Contact support before requesting a replacement.</p><p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
      <template v-if="!challenge && !creationUncertain"><p>Create a DNS challenge for this exact domain. Creating one replaces any previous challenge.</p><UButton :loading="busy" :disabled="busy" @click="begin">Create DNS challenge</UButton></template>
      <div v-else-if="challenge"><p>Add this TXT record to your DNS, then verify it. Keep this page open while publishing; the challenge expires after 24 hours.</p><p>Name: <code>{{ challenge.txt_name }}</code></p><p>Value: <code>{{ challenge.txt_value }}</code></p><UButton :loading="busy" :disabled="busy" @click="verify">Verify DNS record</UButton></div>
    </div>
  </section>
</template>
<style scoped>
.verification { border-top: 1px solid #d9e1e7; padding: 12px 0; }
.verification-content { padding: 8px 12px 16px; }
.verification-content h3 { font-weight: 700; }
.verification-content p { margin: 8px 0; }
.verification-content code { overflow-wrap: anywhere; user-select: all; }
</style>
