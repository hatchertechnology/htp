<script setup lang="ts">
import { dateLabel, validDateRange } from '#shared/utils/analytics'
const route = useRoute()
const ws = useWorkspace()
const { start, end } = useReportRange()
const draftStart = ref(start.value)
const draftEnd = ref(end.value)
const rangeError = ref('')
const picker = ref<HTMLDetailsElement | null>(null)
const navigation = [
  { label: 'Overview', to: '/', icon: 'i-lucide-chart-no-axes-combined' },
  { label: 'Websites', to: '/websites', icon: 'i-lucide-globe' },
  { label: 'Connections', to: '/connections', icon: 'i-lucide-link' },
]
function applyRange() {
  if (!validDateRange(draftStart.value, draftEnd.value)) { rangeError.value = 'Choose an ordered range of up to 366 days.'; return }
  start.value = draftStart.value; end.value = draftEnd.value; rangeError.value = ''
  if (picker.value) picker.value.open = false
}
function preset(days: number) {
  const now = new Date(); draftStart.value = new Date(+now - days * 86400_000).toISOString().slice(0, 10)
  draftEnd.value = new Date(+now - 86400_000).toISOString().slice(0, 10); applyRange()
}
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
        <NuxtLink to="/connections" class="account-link"><span class="account-monogram">{{ (ws.user.value?.email || 'H').slice(0, 1).toUpperCase() }}</span><span>{{ ws.user.value?.email || 'Your account' }}</span><UIcon name="i-lucide-chevron-down" /></NuxtLink>
      </div>
    </aside>
    <div class="desk-workspace">
      <header class="desk-header">
        <label class="website-picker">Website<select v-model="ws.selectedId.value" :disabled="!ws.user.value || ws.loading.value || !ws.sites.value.length" aria-label="Select website"><option v-if="!ws.sites.value.length" value="">{{ ws.loading.value ? 'Loading websites…' : 'Choose a website' }}</option><option v-for="site in ws.sites.value" :key="site.id" :value="site.id">{{ site.fqdn }}</option></select></label>
        <details v-if="route.path === '/'" ref="picker" class="range-picker">
          <summary><span class="control-label">Date range</span><span class="range-value"><UIcon name="i-lucide-calendar-days" />{{ dateLabel(start) }} – {{ dateLabel(end) }}<UIcon name="i-lucide-chevron-down" /></span></summary>
          <form class="range-menu" @submit.prevent="applyRange"><div class="range-presets"><button v-for="days in [7, 28, 90]" :key="days" type="button" @click="preset(days)">Last {{ days }} days</button></div><label>Start date<input v-model="draftStart" type="date" required></label><label>End date<input v-model="draftEnd" type="date" required></label><p v-if="rangeError" role="alert" class="form-error">{{ rangeError }}</p><UButton type="submit" block>Apply dates</UButton></form>
        </details>
        <NuxtLink to="/connections" class="google-indicator"><span :class="['connection-dot', { connected: ws.google.value.connected }]" /><span><strong>Google services</strong><small>{{ !ws.user.value ? 'Sign in to connect' : !ws.connectionReady.value ? 'Checking connection…' : ws.google.value.connected ? 'Connected' : 'Not connected' }}</small></span><UIcon name="i-lucide-chevron-down" /></NuxtLink>
      </header>
      <main id="main-content" class="desk-content"><slot /></main>
    </div>
  </div>
</template>
