<script setup lang="ts">
import { dateLabel, validDateRange } from '#shared/utils/analytics'
import type { RangePreset } from '#shared/utils/workspace-context'

// Rendered only where report dates are read (the overview route, same rule as
// before). The control order and left edge stay fixed on every page, so the
// website select never moves; this whole group only ever appears on '/'.
const ws = useWorkspace()
const { start, end, preset } = ws.range
const draftStart = ref(start.value)
const draftEnd = ref(end.value)
const rangeError = ref('')
const picker = ref<HTMLDetailsElement | null>(null)

// An externally applied range (a rolling preset at a new UTC day, a different
// owner's stored range) keeps the menu's draft fields in step.
watch([start, end], () => { draftStart.value = start.value; draftEnd.value = end.value })

function openState(open: boolean) {
  if (open) { draftStart.value = start.value; draftEnd.value = end.value; rangeError.value = '' }
}

function applyRange() {
  rangeError.value = ''
  if (!validDateRange(draftStart.value, draftEnd.value) || !ws.range.setCustomRange(draftStart.value, draftEnd.value)) {
    rangeError.value = 'Choose an ordered range of up to 366 days.'
    return
  }
  if (picker.value) picker.value.open = false
}

function pick(days: RangePreset) {
  rangeError.value = ''
  ws.range.setPreset(days)
  if (picker.value) picker.value.open = false
}

const label = computed(() => {
  const dates = `${dateLabel(start.value)} – ${dateLabel(end.value)}`
  return preset.value === null ? `Custom · ${dates}` : `Last ${preset.value} days · ${dates}`
})
</script>

<template>
  <div class="range-controls">
    <details ref="picker" class="range-picker" @toggle="openState(picker?.open === true)">
      <summary>
        <span class="control-label">Date range</span>
        <span class="range-value"><UIcon name="i-lucide-calendar-days" />{{ label }}<UIcon name="i-lucide-chevron-down" /></span>
      </summary>
      <form class="range-menu" @submit.prevent="applyRange">
        <div class="range-presets"><button v-for="days in ([7, 28, 90] as const)" :key="days" type="button" @click="pick(days)">Last {{ days }} days</button></div>
        <label>Start date<input v-model="draftStart" type="date" required></label>
        <label>End date<input v-model="draftEnd" type="date" required></label>
        <p v-if="rangeError" role="alert" class="form-error">{{ rangeError }}</p>
        <UButton type="submit" block>Apply dates</UButton>
      </form>
    </details>
    <UButton class="range-shortcut" color="neutral" variant="outline" :aria-pressed="preset === 30" @click="pick(30)">Last 30 days</UButton>
  </div>
</template>
