<script setup lang="ts">
import { FQDN_ERROR, normalizeFqdn } from '#shared/utils/fqdn'
import { businessProfileEnabled } from '#shared/utils/features'
useHead({ title: 'Hatch · Websites' })
const ws = useWorkspace()
const { saving, error: mutationError, mutate } = useWebsites()
const toast = useToast()
const site = computed(() => ws.selected.value)
const domain = ref('')
const domainError = ref('')
const propertyId = ref('')
const propertyBusy = ref(false)
const propertyError = ref('')
const addFqdn = ref('')
const addError = ref('')
const confirmingDelete = ref(false)
const deleteError = ref('')
// A successful delete whose list refresh failed: the removed record is still in
// `ws.sites`, so the page must not keep presenting it as the editable site.
const deletedId = ref('')
// Every async continuation is gated on the selection it started for, so a header
// switch mid-save can never write one site's values into another site's form.
const selectionEpoch = ref(0)
const staleDeleted = computed(() => deletedId.value !== '' && ws.selectedId.value === deletedId.value && ws.sites.value.some(entry => entry.id === deletedId.value))

function current(targetId: string, epoch: number) {
  return epoch === selectionEpoch.value && ws.selectedId.value === targetId
}

// The header select is the source of truth: a site change replaces every
// per-site value, so no stale form data survives the switch.
watch(() => ws.selectedId.value, () => {
  selectionEpoch.value++
  domain.value = site.value?.fqdn ?? ''
  propertyId.value = site.value?.ga4_property_id ?? ''
  domainError.value = ''
  propertyError.value = ''
  propertyBusy.value = false
  confirmingDelete.value = false
  deleteError.value = ''
}, { flush: 'sync', immediate: true })

async function saveDomain() {
  const target = site.value
  if (!target) return
  const targetId = target.id
  const epoch = selectionEpoch.value
  domainError.value = ''
  const canonical = normalizeFqdn(domain.value)
  if (!canonical) { domainError.value = FQDN_ERROR; return }
  const updated = await mutate('PATCH', targetId, canonical)
  if (!current(targetId, epoch)) return
  if (!updated) { domainError.value = mutationError.value || 'Could not save your changes. Please try again.'; return }
  domain.value = updated.fqdn
  await ws.load()
  if (!current(targetId, epoch)) return
  domain.value = site.value?.fqdn ?? ''
  toast.add({ title: 'Website updated', description: 'Forms, if any, were paused. Verify their hosts again before reactivating them.', color: 'success', icon: 'i-lucide-check' })
}

async function saveProperty() {
  const target = site.value
  if (!target) return
  const targetId = target.id
  const epoch = selectionEpoch.value
  if (propertyId.value && !/^[1-9][0-9]{0,19}$/.test(propertyId.value)) { propertyError.value = 'Enter a numeric GA4 property ID.'; return }
  propertyBusy.value = true; propertyError.value = ''
  try {
    await ws.request(`/api/websites/${targetId}/analytics/property`, { method: 'PUT', body: { property_id: propertyId.value || null } })
    if (!current(targetId, epoch)) return
    await ws.load()
    if (!current(targetId, epoch)) return
    propertyId.value = site.value?.ga4_property_id ?? ''
    toast.add({ title: 'Analytics property saved', color: 'success' })
  } catch (cause) {
    if (current(targetId, epoch)) propertyError.value = failureMessage(cause)
  } finally {
    if (current(targetId, epoch)) propertyBusy.value = false
  }
}

async function addWebsite() {
  const epoch = selectionEpoch.value
  addError.value = ''
  const canonical = normalizeFqdn(addFqdn.value)
  if (!canonical) { addError.value = FQDN_ERROR; return }
  const created = await mutate('POST', undefined, canonical)
  if (!created) { if (epoch === selectionEpoch.value) addError.value = mutationError.value || 'Could not save your changes. Please try again.'; return }
  addFqdn.value = ''
  await ws.load()
  if (epoch !== selectionEpoch.value) {
    toast.add({ title: 'Website added', description: 'Choose it in the header to edit it.', color: 'success', icon: 'i-lucide-check' })
    return
  }
  if (!ws.selectWebsite(created.id)) {
    addError.value = 'Website added, but it could not be selected. Reload the website list and choose it in the header.'
    return
  }
  toast.add({ title: 'Website added', color: 'success', icon: 'i-lucide-check' })
}

async function removeWebsite() {
  const target = site.value
  if (!target) return
  const targetId = target.id
  const epoch = selectionEpoch.value
  deleteError.value = ''
  const removed = await mutate('DELETE', targetId, target.fqdn)
  if (!removed) { if (current(targetId, epoch)) deleteError.value = mutationError.value || 'Could not delete this website. Please try again.'; return }
  await ws.load()
  if (!current(targetId, epoch)) return
  if (ws.error.value) {
    deletedId.value = targetId
    toast.add({ title: 'Website deleted', description: 'The website list could not be refreshed.', color: 'success', icon: 'i-lucide-check' })
    return
  }
  deletedId.value = ''
  toast.add({ title: 'Website deleted', color: 'success', icon: 'i-lucide-check' })
}

async function reloadDeleted() {
  await ws.load()
  if (!ws.sites.value.some(entry => entry.id === deletedId.value)) deletedId.value = ''
}
</script>

<template>
  <div class="site-settings-page">
    <div class="page-heading">
      <h1>Website settings</h1>
      <p v-if="site && !staleDeleted" data-testid="website-settings-fqdn" class="site-settings-fqdn">{{ site.fqdn }}</p>
      <p v-else-if="staleDeleted">This website was deleted.</p>
      <p v-else-if="ws.contextReady.value">Add your first website to start collecting reports.</p>
      <p v-else-if="!ws.user.value">Sign in to manage your websites.</p>
      <p v-else>Reading your websites…</p>
    </div>
    <p v-if="ws.sitesTruncated.value" class="report-caption">Only the first 1,000 websites are available in the selector.</p>
    <p v-if="ws.contextReady.value && ws.error.value && !staleDeleted" class="form-error" role="alert">{{ ws.error.value }} <UButton variant="link" @click="ws.load()">Try again</UButton></p>
    <div v-if="!ws.user.value" class="surface settings-loading" role="status">Sign in to manage your websites. <NuxtLink to="/sign-in?redirect=/websites">Sign in</NuxtLink></div>
    <div v-else-if="!ws.contextReady.value" class="surface settings-loading" role="status">Loading website settings…</div>
    <section v-else-if="staleDeleted" class="surface settings-section" role="status" aria-labelledby="deleted-heading">
      <h2 id="deleted-heading">Website deleted</h2>
      <p>This website was removed, but the website list could not be refreshed. It may still appear in the header.</p>
      <div class="settings-actions"><UButton @click="reloadDeleted">Reload website list</UButton></div>
    </section>
    <template v-else-if="site">
      <section class="surface settings-section" aria-labelledby="domain-heading">
        <h2 id="domain-heading">Domain</h2>
        <p>Enter the full domain name, including any subdomain. For example, www.example.com.</p>
        <form @submit.prevent="saveDomain">
          <UFormField label="Domain name (FQDN)" name="fqdn" :error="domainError || undefined">
            <UInput id="website-fqdn" v-model="domain" placeholder="www.example.com" size="lg" type="text" inputmode="url" autocomplete="off" autocapitalize="none" :spellcheck="false" required :disabled="saving" :maxlength="1024" @update:model-value="domainError = ''" />
          </UFormField>
          <div class="settings-actions"><p>Domain records only. Your website’s content stays untouched.</p><UButton type="submit" :loading="saving" :disabled="saving">Save domain</UButton></div>
        </form>
      </section>

      <section class="surface settings-section" aria-labelledby="analytics-heading">
        <h2 id="analytics-heading">Google Analytics property</h2>
        <p>Link the numeric GA4 property that reports for this domain.</p>
        <form @submit.prevent="saveProperty">
          <UFormField label="GA4 property ID" help="Find the numeric ID in Google Analytics → Admin → Property details. Leave blank to unlink."><UInput v-model="propertyId" inputmode="numeric" placeholder="557292489" :disabled="propertyBusy" /></UFormField>
          <p v-if="propertyError" class="form-error" role="alert">{{ propertyError }}</p>
          <div class="settings-actions"><UButton type="submit" :loading="propertyBusy" :disabled="propertyBusy">Save property</UButton></div>
        </form>
      </section>

      <section v-if="businessProfileEnabled" class="surface settings-section" aria-labelledby="location-heading">
        <h2 id="location-heading">Business location</h2>
        <p>Business Profile location tracking is managed with the other Business Profile reports. <NuxtLink to="/#business-title">Open the Business Profile section</NuxtLink>.</p>
      </section>

      <section class="surface settings-section" aria-labelledby="repository-heading">
        <h2 id="repository-heading">GitHub repository</h2>
        <RepositorySettings :website-id="site.id" :fqdn="site.fqdn" />
      </section>
    </template>

    <section v-if="ws.user.value && ws.contextReady.value && !staleDeleted" class="surface settings-section" aria-labelledby="add-website-heading">
      <h2 id="add-website-heading">Add a website</h2>
      <p>Enter the full domain name, including any subdomain. For example, www.example.com.</p>
      <form @submit.prevent="addWebsite">
        <UFormField label="Domain name (FQDN)" name="new-fqdn" :error="addError || undefined">
          <UInput v-model="addFqdn" data-testid="new-website-fqdn" placeholder="www.example.com" size="lg" type="text" inputmode="url" autocomplete="off" autocapitalize="none" :spellcheck="false" required :disabled="saving" :maxlength="1024" @update:model-value="addError = ''" />
        </UFormField>
        <div class="settings-actions"><p>Domain records only. Your website’s content stays untouched.</p><UButton type="submit" icon="i-lucide-plus" :loading="saving" :disabled="saving">Add website</UButton></div>
      </form>
    </section>

    <section v-if="site && !staleDeleted" class="surface settings-section danger-section" aria-labelledby="delete-heading">
      <h2 id="delete-heading">Delete this website</h2>
      <p>Removes the website record for this domain. This cannot be undone.</p>
      <p v-if="deleteError" class="form-error" role="alert">{{ deleteError }}</p>
      <div v-if="confirmingDelete" class="delete-confirm" role="group" :aria-label="`Confirm deletion of ${site.fqdn}`">
        <p>Delete <strong>{{ site.fqdn }}</strong>? This removes the website record and any empty form configuration. Websites with saved form responses or independent audit evidence cannot be deleted until those records are explicitly removed. If a notification is sending, try again after delivery.</p>
        <div class="settings-actions"><UButton color="neutral" variant="outline" :disabled="saving" @click="confirmingDelete = false">Cancel</UButton><UButton color="error" :loading="saving" @click="removeWebsite">Delete record</UButton></div>
      </div>
      <div v-else class="settings-actions"><UButton color="error" variant="outline" icon="i-lucide-trash-2" :disabled="saving" @click="confirmingDelete = true">Delete this website</UButton></div>
    </section>
  </div>
</template>

<style scoped>
.site-settings-page { display: grid; gap: 24px; max-width: 960px; }
.site-settings-page .page-heading { margin-bottom: 0; }
.site-settings-fqdn { color: var(--ink); font-size: 17px; overflow-wrap: anywhere; }
.settings-loading { padding: 24px; color: var(--muted); }
.settings-section { padding: 24px; }
.settings-section h2 { margin-bottom: 6px; }
.settings-section > p { color: var(--muted); max-width: 65ch; margin-bottom: 16px; }
.settings-section > p:last-child { margin-bottom: 0; }
.settings-section form { display: grid; gap: 14px; }
.settings-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.settings-actions > p { color: var(--muted); font-size: 13px; max-width: 52ch; }
.danger-section { border-color: #e3c3b4; }
.danger-section h2 { color: #943311; }
.delete-confirm { display: grid; gap: 14px; }
.delete-confirm > p { color: var(--ink); max-width: 65ch; }
@media (max-width: 650px) {
  .settings-section { padding: 20px; }
  .settings-actions { flex-direction: column; align-items: stretch; }
  .settings-actions > p { max-width: none; }
}
</style>
