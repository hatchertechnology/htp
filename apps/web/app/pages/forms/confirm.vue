<script setup lang="ts">
import { confirmationBody, confirmationUrl, confirmed } from '#shared/utils/forms-confirm-client'
useHead({title:'Confirm form notifications',meta:[{name:'referrer',content:'no-referrer'}]})
definePageMeta({ layout: 'public' })
const config = useRuntimeConfig().public
const formsEnabled = config.staticDashboard === true
  ? config.rolloutFormsConfirmation === true
  : config.rolloutForms === true && config.rolloutFormsPilot !== true
const recipient = ref(''), token = ref(''), busy = ref(false), done = ref(false), error = ref('')
onMounted(() => { const parts=location.hash.slice(1).split(':'); recipient.value=parts[0] || ''; token.value=parts[1] || ''; history.replaceState(null,'',location.pathname) })
async function confirm() {
  if (!formsEnabled || busy.value || done.value) return
  busy.value=true; error.value=''
  try {
    const result = await $fetch(confirmationUrl(config.staticDashboard === true, config.apiBaseUrl), {method:'POST', body:confirmationBody(recipient.value,token.value), timeout:12_000, retry:0, redirect:'error', credentials:'omit'})
    if (!confirmed(result)) throw new Error('Unconfirmed')
    done.value=true; token.value=''
  }
  catch { error.value='This confirmation link is invalid, expired, or temporarily unavailable. Ask the website owner to send a new invitation.' }
  finally { busy.value=false }
}
</script>
<template><main class="confirm-page"><section class="surface"><h1>Form notifications</h1><p v-if="!formsEnabled" role="status">Form notifications are not available yet.</p><p v-else-if="done" role="status">Your email address is confirmed. You can close this page.</p><template v-else><p>Confirm that you want to receive notifications for this website form.</p><p v-if="error" role="alert">{{ error }}</p><UButton :disabled="!recipient || !token" :loading="busy" @click="confirm">Confirm notifications</UButton></template></section></main></template>
<style scoped>.confirm-page { max-width: 42rem; padding: 32px 16px; margin: 0 auto; }.surface { padding: 24px; }.confirm-page h1 { font-size: 1.5rem; font-weight: 700; }.confirm-page p { margin: 16px 0; }</style>
