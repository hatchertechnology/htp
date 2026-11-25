<script setup lang="ts">
import { formsSurface } from '#shared/utils/forms-availability'

const route = useRoute()
const ws = useWorkspace()
const runtime = useRuntimeConfig().public as Parameters<typeof formsSurface>[0]
const forms = formsSurface(runtime)
// A writable computed so the native select's v-model reads the validated
// selection and writes back through selectWebsite (which persists it).
const selectedSite = computed({
  get: () => ws.selectedId.value,
  set: (id: string) => { ws.selectWebsite(id) },
})
const navigation = [
  { label: 'Overview', to: '/', icon: 'i-lucide-chart-no-axes-combined' },
  { label: 'Websites', to: '/websites', icon: 'i-lucide-globe' },
  ...(forms.enabled ? [{ label: 'Forms', to: '/forms', icon: 'i-lucide-messages-square' }] : []),
  { label: 'Connections', to: '/connections', icon: 'i-lucide-link' },
]
</script>

<template>
  <a href="#main-content" class="skip-link">Skip to content</a>
  <div class="desk-shell">
    <aside class="desk-rail">
      <NuxtLink to="/" class="desk-brand" aria-label="Hatch home">Hatch<span class="brand-stop">.</span></NuxtLink>
      <nav aria-label="Main navigation" class="desk-nav">
        <NuxtLink v-for="item in navigation" :key="item.to" :to="item.to" :class="{ active: route.path === item.to }"><UIcon :name="item.icon" /><span>{{ item.label }}</span></NuxtLink>
      </nav>
      <div class="rail-bottom">
        <NuxtLink to="/developer" class="developer-link"><UIcon name="i-lucide-code-xml" />Developer tools</NuxtLink>
        <UserMenu />
      </div>
    </aside>
    <div class="desk-workspace">
      <header class="desk-header">
        <label class="website-picker">Website<select v-model="selectedSite" :disabled="!ws.contextReady.value || !ws.sites.value.length" aria-label="Select website"><option v-if="!ws.sites.value.length" value="">{{ ws.loading.value ? 'Loading websites…' : 'Choose a website' }}</option><option v-for="site in ws.sites.value" :key="site.id" :value="site.id">{{ site.fqdn }}</option></select></label>
        <UButton v-if="ws.contextReady.value && ws.error.value" class="website-retry" variant="link" @click="ws.load()">Retry</UButton>
        <DateRangeControl v-if="route.path === '/'" />
      </header>
      <main id="main-content" class="desk-content"><slot /></main>
    </div>
  </div>
</template>
