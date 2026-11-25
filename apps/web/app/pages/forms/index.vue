<script setup lang="ts">
import { formsSurface } from '#shared/utils/forms-availability'
useHead({ title: 'Hatch · Forms' })
const ws = useWorkspace()
const config = useRuntimeConfig()
const surface = computed(() => formsSurface(config.public as { rolloutForms?: unknown; rolloutFormsPilot?: unknown }))
</script>

<template>
  <div class="forms-page">
    <div class="page-heading">
      <h1>Forms</h1>
      <p v-if="surface.enabled && ws.selected.value">{{ ws.selected.value.fqdn }}</p>
      <p v-else>Manage forms and review submissions for the selected website.</p>
    </div>

    <section v-if="!surface.enabled" class="surface forms-unavailable" aria-label="Forms availability">
      <h2>Forms</h2>
      <p>Forms are not available in this workspace yet.</p>
    </section>

    <template v-else>
      <section v-if="!ws.contextReady.value" class="surface forms-loading" role="status">Reading your websites…</section>
      <p v-else-if="ws.error.value" class="form-error" role="alert">{{ ws.error.value }} <UButton variant="link" @click="ws.load()">Try again</UButton></p>
      <section v-else-if="!ws.selected.value" class="surface forms-unavailable" aria-label="Forms needs a website">
        <h2>Forms</h2>
        <p>Add a website first to use Forms. <NuxtLink to="/websites">Go to Website settings</NuxtLink>.</p>
      </section>
      <WebsiteForms
        v-else
        :key="ws.selectedId.value"
        :website-id="ws.selected.value.id"
        :fqdn="ws.selected.value.fqdn"
        :mode="surface.mode"
      />
    </template>
  </div>
</template>

<style scoped>
.forms-page { min-width: 0; }
.forms-unavailable, .forms-loading { padding: 24px; }
.forms-unavailable h2 { font-size: 24px; margin-bottom: 6px; }
.forms-unavailable p, .forms-loading { color: var(--muted); max-width: 65ch; }
.forms-unavailable a { color: var(--rust); text-decoration: underline; }
</style>
