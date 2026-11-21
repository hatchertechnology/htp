<script setup lang="ts">
useHead({title:'Confirm form notifications',meta:[{name:'referrer',content:'no-referrer'}]})
const recipient = ref(''), token = ref(''), busy = ref(false), done = ref(false), error = ref('')
onMounted(() => { const parts=location.hash.slice(1).split(':'); recipient.value=parts[0] || ''; token.value=parts[1] || ''; history.replaceState(null,'',location.pathname) })
async function confirm() {
  busy.value=true; error.value=''
  try { await $fetch('/api/forms/confirm',{method:'POST',body:{recipient_id:recipient.value,token:token.value},retry:0}); done.value=true; token.value='' }
  catch { error.value='This confirmation link is invalid, expired, or temporarily unavailable. Ask the website owner to send a new invitation.' }
  finally { busy.value=false }
}
</script>
<template><main class="confirm-page"><section class="surface"><h1>Form notifications</h1><p v-if="done" role="status">Your email address is confirmed. You can close this page.</p><template v-else><p>Confirm that you want to receive notifications for this website form.</p><p v-if="error" role="alert">{{ error }}</p><UButton :disabled="!recipient || !token" :loading="busy" @click="confirm">Confirm notifications</UButton></template></section></main></template>
<style scoped>.confirm-page { max-width: 42rem; padding: 32px 16px; margin: 0 auto; }.surface { padding: 24px; }.confirm-page h1 { font-size: 1.5rem; font-weight: 700; }.confirm-page p { margin: 16px 0; }</style>
