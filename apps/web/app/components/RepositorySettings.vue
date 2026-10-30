<script setup lang="ts">
const props = defineProps<{ websiteId: string; fqdn: string }>()
const opened = ref(false)
const today = new Date().toISOString().slice(0, 10)
const { history, busy, error, load } = useRepositoryHistory(() => props.websiteId, () => today, () => today, () => opened.value, false)
const ws = useWorkspace()
const url = ref('')
const branch = ref('')
const enabled = ref(true)
const saving = ref(false)
const saveError = ref('')
const notice = ref('')
watch(() => history.value?.repository, binding => { url.value = binding?.repository_url ?? ''; branch.value = binding?.branch ?? ''; enabled.value = binding?.enabled ?? true })
async function save(unlink = false) {
  saving.value = true; saveError.value = ''; notice.value = ''
  try {
    await ws.request(`/api/websites/${props.websiteId}/repository`, { method: 'PUT', body: { repository_url: unlink ? null : url.value, branch: branch.value || null, enabled: enabled.value } })
    await load()
    notice.value = unlink ? 'Collection stopped. Saved history is retained.' : 'Repository saved. Background collection will pick up the change shortly.'
  } catch (cause) { saveError.value = failureMessage(cause) }
  finally { saving.value = false }
}
</script>
<template>
  <details class="repository-settings" @toggle="opened = ($event.target as HTMLDetailsElement).open">
    <summary>GitHub repository for {{ fqdn }}</summary>
    <p>Link a public repository to collect commit history hourly. Leave the branch blank to follow its default branch.</p>
    <p v-if="error || saveError" class="form-error" role="alert">{{ saveError || error }} <button v-if="error" type="button" @click="load()">Try again</button></p>
    <p v-if="notice" class="form-notice" role="status">{{ notice }}</p>
    <form class="property-form" @submit.prevent="save()">
      <UFormField label="Public GitHub repository URL" :name="`repository-${websiteId}`"><UInput v-model="url" type="url" placeholder="https://github.com/owner/repository" :disabled="busy || saving || !history" required :maxlength="256" /></UFormField>
      <UFormField label="Branch (optional)" :name="`branch-${websiteId}`"><UInput v-model="branch" placeholder="Default branch" :disabled="busy || saving || !history" :maxlength="255" /></UFormField>
      <label class="repository-enabled"><input v-model="enabled" type="checkbox" :disabled="busy || saving || !history"> Collect changes automatically</label>
      <div class="website-form-actions"><UButton type="submit" :loading="saving" :disabled="busy || !history">Save repository</UButton><UButton v-if="history?.repository?.enabled" type="button" variant="outline" color="neutral" :disabled="busy || saving || !history" @click="save(true)">Stop collection</UButton></div>
    </form>
  </details>
</template>
