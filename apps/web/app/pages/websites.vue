<script setup lang="ts">
import type { Website } from '../../shared/types/websites'
import { FQDN_ERROR, normalizeFqdn } from '#shared/utils/fqdn'
useHead({ title: 'Hatch · Websites' })
const { user, ready } = useAuth()
const { items, hasMore, loading, saving, error, load, mutate } = useWebsites()
const toast = useToast()
const workspace = useWorkspace()
const propertySite = ref<Website | null>(null)
const propertyId = ref('')
const propertyBusy = ref(false)
const propertyError = ref('')
async function saveProperty() {
  if (!propertySite.value) return
  if (propertyId.value && !/^[1-9][0-9]{0,19}$/.test(propertyId.value)) { propertyError.value = 'Enter a numeric GA4 property ID.'; return }
  propertyBusy.value = true; propertyError.value = ''
  try {
    await workspace.request(`/api/websites/${propertySite.value.id}/analytics/property`, { method: 'PUT', body: { property_id: propertyId.value || null } })
    await Promise.all([load(), workspace.load()]); propertySite.value = null
    toast.add({ title: 'Analytics property saved', color: 'success' })
  } catch (cause) { propertyError.value = failureMessage(cause) }
  finally { propertyBusy.value = false }
}
const fqdn = ref('')
const validation = ref('')
const editing = ref<Website | null>(null)
const removing = ref<Website | null>(null)

function cancelEdit() { editing.value = null; fqdn.value = ''; validation.value = '' }
async function edit(website: Website) {
  editing.value = website
  removing.value = null
  fqdn.value = website.fqdn
  validation.value = ''
  await nextTick()
  document.getElementById('website-fqdn')?.focus()
}
async function save() {
  validation.value = ''
  const canonical = normalizeFqdn(fqdn.value)
  if (!canonical) { validation.value = FQDN_ERROR; return }
  const updated = Boolean(editing.value)
  if (await mutate(updated ? 'PATCH' : 'POST', editing.value?.id, canonical)) {
    cancelEdit()
    await workspace.load()
    toast.add({ title: updated ? 'Website updated' : 'Website added', color: 'success', icon: 'i-lucide-check' })
  }
}
async function remove() {
  if (!removing.value) return
  if (await mutate('DELETE', removing.value.id)) {
    if (editing.value?.id === removing.value.id) cancelEdit()
    removing.value = null
    await workspace.load()
    toast.add({ title: 'Website deleted', color: 'success', icon: 'i-lucide-check' })
  }
}
watch(() => user.value?.id, () => { cancelEdit(); removing.value = null })
</script>

<template>
  <div>
    <div class="page-heading"><h1>Websites</h1><p>Manage your client domains and link each one to its GA4 property.</p></div>
    <div class="websites-layout">
      <div class="websites-main">
        <section class="website-form surface" aria-labelledby="website-form-heading">
          <h2 id="website-form-heading">{{ editing ? 'Edit website' : 'Add a website' }}</h2>
          <p>Enter the full domain name, including any subdomain. For example, www.dreamcleanmacon.com.</p>
          <form @submit.prevent="save">
            <UFormField label="Domain name (FQDN)" name="fqdn" :error="validation || undefined">
              <UInput id="website-fqdn" v-model="fqdn" placeholder="www.example.com" size="lg" type="text" inputmode="url" autocomplete="off" autocapitalize="none" :spellcheck="false" required :disabled="!user || saving || !ready" :maxlength="1024" @update:model-value="validation = ''" />
            </UFormField>
            <div class="website-form-actions"><p>{{ user ? 'Domain records only. Your website’s content stays untouched.' : ready ? 'Sign in to add and manage websites.' : 'Checking your session…' }}</p><UButton v-if="editing" color="neutral" variant="outline" :disabled="saving" @click="cancelEdit">Cancel edit</UButton><UButton type="submit" :icon="editing ? 'i-lucide-check' : 'i-lucide-plus'" :loading="saving" :disabled="!user || loading || !ready">{{ editing ? 'Save changes' : 'Add website' }}</UButton></div>
          </form>
        </section>
        <section class="website-list surface" aria-labelledby="websites-list-heading" :aria-busy="loading">
          <div class="website-list-heading"><h2 id="websites-list-heading">Your websites</h2><UButton icon="i-lucide-refresh-cw" aria-label="Refresh websites" color="neutral" variant="ghost" :loading="loading" :disabled="!user || saving" @click="load()" /></div>
          <div v-if="error" class="website-error" role="alert"><p>{{ error }}</p><UButton v-if="!saving && !loading" variant="link" @click="load()">Try again</UButton></div>
          <div v-if="!ready || (loading && !items.length)" class="website-empty" role="status"><UIcon name="i-lucide-loader-circle" class="request-spinner" /><h3>Loading your websites…</h3></div>
          <div v-else-if="!user" class="website-empty"><UIcon name="i-lucide-lock-keyhole" /><h3>Your websites are private.</h3><p>Sign in to view, add, and manage your domain records.</p></div>
          <div v-else-if="!items.length && !error" class="website-empty"><UIcon name="i-lucide-globe" /><h3>Your first website starts here.</h3><p>Add a domain above. You can rename or remove the record at any time.</p></div>
          <ul v-else class="website-rows" aria-label="Website records">
            <li v-for="website in items" :key="website.id" class="website-row">
              <div class="website-record"><span class="website-record-icon"><UIcon name="i-lucide-globe" /></span><div><strong>{{ website.fqdn }}</strong><span>{{ website.ga4_property_id ? `GA4 property ${website.ga4_property_id}` : 'Analytics property not linked' }}</span></div><div class="website-row-actions"><UButton color="neutral" variant="ghost" icon="i-lucide-chart-no-axes-combined" :aria-label="`Analytics settings for ${website.fqdn}`" @click="propertySite = website; propertyId = website.ga4_property_id || ''; propertyError = ''">Analytics</UButton><UButton color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="`Edit ${website.fqdn}`" :disabled="saving || loading" @click="edit(website)">Edit</UButton><UButton color="neutral" variant="ghost" icon="i-lucide-trash-2" :aria-label="`Delete ${website.fqdn}`" :disabled="saving || loading" @click="removing = website">Delete</UButton></div></div>
              <form v-if="propertySite?.id === website.id" class="property-form" @submit.prevent="saveProperty">
                <UFormField label="GA4 property ID" help="Find the numeric ID in Google Analytics → Admin → Property details. Leave blank to unlink."><UInput v-model="propertyId" inputmode="numeric" placeholder="557292489" :disabled="propertyBusy" /></UFormField>
                <p v-if="propertyError" class="form-error" role="alert">{{ propertyError }}</p>
                <div class="website-form-actions"><UButton type="submit" :loading="propertyBusy">Save property</UButton><UButton variant="outline" color="neutral" :disabled="propertyBusy" @click="propertySite = null">Cancel</UButton></div>
              </form>
              <div v-if="removing?.id === website.id" class="website-delete" role="group" :aria-label="`Confirm deletion of ${website.fqdn}`"><p>Delete <strong>{{ website.fqdn }}</strong>? This removes the record only.</p><div><UButton color="neutral" variant="outline" :disabled="saving" @click="removing = null">Cancel</UButton><UButton color="error" :loading="saving" @click="remove">Delete record</UButton></div></div>
            </li>
          </ul>
          <div v-if="hasMore" class="website-load-more"><UButton color="neutral" variant="outline" :loading="loading" :disabled="saving" @click="load(true)">Load more websites</UButton></div>
        </section>
      </div>
      <AccountPanel context="websites" />
    </div>
  </div>
</template>
