<script setup lang="ts">
import { notificationUrl, notificationPage, notificationResult, notificationUnknown, type Recipient, type Delivery, type Collection } from '#shared/utils/forms-notification-client'
import { sessionEndedError } from '#shared/utils/forms-owner-client'
import { formatInstant, zoneLabel } from '#shared/utils/local-time'
const props = defineProps<{ websiteId: string; formId: string }>()
const auth = useAuth(), config = useRuntimeConfig()
const recipients = ref<Recipient[]>([]), jobs = ref<Delivery[]>([])
const moreRecipients = ref(false), moreJobs = ref(false), busy = ref(false), unresolved = ref(false), email = ref(''), message = ref(''), error = ref('')
const offsets = { recipients: 0, 'delivery-jobs': 0 }
const readError = ref('')
function appendUnique<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  return [...new Map([...current, ...incoming].map(row => [row.id, row])).values()]
}
let generation = 0
onBeforeUnmount(() => { generation++ })
async function page(collection: Collection, more = false) {
  const token = await auth.accessToken()
  if (!token) throw sessionEndedError()
  const offset = more ? offsets[collection] : 0
  const value = await $fetch(notificationUrl(props.websiteId, props.formId, collection, config.public.apiBaseUrl, offset), { headers: { Authorization: `Bearer ${token}` }, retry: 0, redirect: 'error' })
  return notificationPage(value, collection)
}
async function read(collection?: Collection, more = false, preserveFeedback = false) {
  if (busy.value) return
  const ticket = generation
  busy.value = true; readError.value = ''
  if (!preserveFeedback) error.value = ''
  try {
    const [r, j] = await Promise.all([collection === 'delivery-jobs' ? null : page('recipients', more), collection === 'recipients' ? null : page('delivery-jobs', more)])
    if (ticket !== generation) return
    if (r) { offsets.recipients = (more ? offsets.recipients : 0) + r.items.length; recipients.value = more ? appendUnique(recipients.value, r.items as Recipient[]) : r.items as Recipient[]; moreRecipients.value = r.has_more }
    if (j) { offsets['delivery-jobs'] = (more ? offsets['delivery-jobs'] : 0) + j.items.length; jobs.value = more ? appendUnique(jobs.value, j.items as Delivery[]) : j.items as Delivery[]; moreJobs.value = j.has_more }
    if (!collection) unresolved.value = false
  } catch { if (ticket === generation) readError.value = 'Could not read notification metadata. Reload before another attempt.' }
  finally { if (ticket === generation) busy.value = false }
}
async function write(action: 'create' | 'disable' | 'retry', row?: Recipient | Delivery) {
  if (busy.value || unresolved.value) return
  if (action === 'retry' && (row as Delivery)?.state === 'uncertain' && !window.confirm('The provider may already have delivered this message. Check provider records first. Retry and risk a duplicate email?')) return
  const ticket = generation
  busy.value = true; error.value = ''; message.value = ''
  let sent = false
  try {
    const url = notificationUrl(props.websiteId, props.formId, action === 'retry' ? 'delivery-jobs' : 'recipients', config.public.apiBaseUrl, undefined, row?.id)
    const token = await auth.accessToken()
    if (!token) throw sessionEndedError()
    if (ticket !== generation) return
    sent = true
    const result = await $fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, ...(action === 'create' ? { body: { email: email.value.trim() } } : {}), retry: 0, redirect: 'error' })
    if (!notificationResult(result, action, row?.id)) throw new Error('Unknown result')
    if (ticket !== generation) return
    message.value = action === 'disable' ? 'Recipient disabled.' : 'Queue request accepted. This does not confirm verification or email delivery.'
    if (action === 'create') email.value = ''
  } catch (cause) {
    if (ticket !== generation) return
    unresolved.value = sent && notificationUnknown(cause)
    error.value = unresolved.value ? 'Outcome unknown. The request was not retried. Reload recipients and delivery jobs, and check provider records before another explicit attempt.' : 'Request refused or not sent. Reload notification metadata before trying again.'
  } finally { if (ticket === generation) busy.value = false }
  // Unknown outcomes stay locked until an explicit successful full readback.
  if (!unresolved.value && ticket === generation) await read(undefined, false, true)
}
onMounted(() => read())
</script>
<template>
  <section class="forms-block" aria-label="Form notifications">
    <h4>Notification recipients and delivery</h4>
    <p>Recipients must verify their address. Queue acceptance does not confirm email delivery. “sent” records provider acceptance, not inbox arrival. Times show in your timezone ({{ zoneLabel() }}).</p>
    <p v-if="readError" role="alert">{{ readError }}</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <UButton :disabled="busy" color="neutral" variant="outline" @click="read()">Reload notification metadata</UButton>
    <form @submit.prevent="write('create')"><label>Email address <input v-model="email" type="email" required maxlength="254"></label><UButton type="submit" :disabled="busy || unresolved">Request verification</UButton></form>
    <p v-if="!recipients.length">No recipients on this page.</p>
    <ul><li v-for="r in recipients" :key="r.id">{{ r.email }} — {{ !r.enabled ? 'Disabled' : r.verified_at ? 'Verified' : 'Awaiting verification' }} · Created <time :datetime="r.created_at" :title="r.created_at">{{ formatInstant(r.created_at) }}</time><UButton v-if="r.enabled" :disabled="busy || unresolved" color="neutral" variant="ghost" @click="write('disable', r)">Disable recipient</UButton></li></ul>
    <UButton v-if="moreRecipients" :disabled="busy" @click="read('recipients', true)">More recipients</UButton>
    <h4>Delivery jobs</h4><p v-if="!jobs.length">No delivery jobs on this page.</p>
    <ul><li v-for="job in jobs" :key="job.id"><p>{{ job.kind }}: {{ job.state }} · Attempts {{ job.attempts }} · Updated <time :datetime="job.updated_at" :title="job.updated_at">{{ formatInstant(job.updated_at) }}</time></p><p>Recipient {{ job.recipient_id }} · Response {{ job.response_id || 'None' }} · Job {{ job.id }}</p><p v-if="job.state === 'uncertain'">Provider outcome unknown. Check provider records before resending; a retry can duplicate delivery.</p><p v-if="job.kind === 'verification' && job.state === 'uncertain'">Request fresh verification if needed.</p><UButton v-if="job.state === 'failed' || job.kind === 'response' && job.state === 'uncertain'" :disabled="busy || unresolved" color="neutral" variant="ghost" @click="write('retry', job)">Retry delivery</UButton></li></ul>
    <UButton v-if="moreJobs" :disabled="busy" @click="read('delivery-jobs', true)">More delivery jobs</UButton>
  </section>
</template>
<style scoped>
.forms-block { border-top: 1px solid var(--border); padding: 16px 0; margin-top: 16px; overflow-wrap: anywhere; }
h4 { font-weight: 650; font-size: 19px; margin: 8px 0; } form { display: grid; gap: 8px; margin: 12px 0; } form > button { justify-self: start; } input { border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; max-width: 100%; } p { color: var(--muted); max-width: 70ch; } li { margin: 12px 0; } time { font-variant-numeric: tabular-nums; }
</style>
