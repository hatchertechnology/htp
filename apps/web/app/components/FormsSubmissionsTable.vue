<script setup lang="ts">
import { formatInstant, userTimeZone, zoneLabel } from '#shared/utils/local-time'
import {
  DEFAULT_SUBMISSION_QUERY, applySubmissionQuery,
  type SubmissionQuery, type SubmissionRow, type SubmissionStatus, type SortKey,
} from '#shared/utils/forms-submissions-table'

const props = defineProps<{
  rows: SubmissionRow[]
  columns: Array<{ key: string; label: string }>
  hasMore: boolean
  loading: boolean
  busy: boolean
  locked: boolean
  canManage: boolean
  canMarkNew: boolean
}>()
const emit = defineEmits<{
  (event: 'status', row: SubmissionRow, next: SubmissionStatus): void
  (event: 'delete', row: SubmissionRow): void
  (event: 'bulk-status', ids: string[], next: SubmissionStatus): void
  (event: 'load-more'): void
  (event: 'export'): void
}>()

const zone = userTimeZone()
const zoneName = zoneLabel(zone)
function freshQuery(): SubmissionQuery {
  return {
    ...DEFAULT_SUBMISSION_QUERY,
    sort: { ...DEFAULT_SUBMISSION_QUERY.sort },
    statuses: [...DEFAULT_SUBMISSION_QUERY.statuses],
    timeZone: zone,
  }
}
const query = ref<SubmissionQuery>(freshQuery())
const selectedIds = ref<string[]>([])
const confirmingDelete = ref<string | null>(null)
const visibleRows = computed(() => applySubmissionQuery(props.rows, query.value))
const visibleCount = computed(() => visibleRows.value.length)
const loadedCount = computed(() => props.rows.length)
const filtersHideRows = computed(() => visibleCount.value !== loadedCount.value)
const allVisibleSelected = computed(() => visibleCount.value > 0 && visibleRows.value.every(row => selectedIds.value.includes(row.id)))
const someVisibleSelected = computed(() => visibleRows.value.some(row => selectedIds.value.includes(row.id)))

// A filter change must never leave an invisible row selected for a bulk action.
watch(visibleRows, rows => {
  const visible = new Set(rows.map(row => row.id))
  selectedIds.value = selectedIds.value.filter(id => visible.has(id))
})

const statusOptions: Array<{ value: SubmissionStatus; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'spam', label: 'Spam' },
]

function hasStatus(status: SubmissionStatus): boolean {
  return query.value.statuses.includes(status)
}
function onStatusChange(status: SubmissionStatus, event: Event) {
  const input = event.target as HTMLInputElement
  toggleStatus(status, input.checked)
  // Removing the last status keeps that status applied. The DOM has already
  // flipped the box, and the VDOM value did not change, so restore it directly
  // to keep the checkbox state equal to the applied filter.
  if (input.checked !== hasStatus(status)) input.checked = hasStatus(status)
}
function toggleStatus(status: SubmissionStatus, checked: boolean) {
  const current = new Set(query.value.statuses)
  if (checked) current.add(status)
  else current.delete(status)
  // Empty means "all" in the query contract, which would contradict three
  // unchecked boxes. Keep at least one status selected.
  if (!current.size) current.add(status)
  query.value.statuses = statusOptions.map(option => option.value).filter(value => current.has(value))
}
function sameSort(left: SortKey, right: SortKey): boolean {
  if (left.kind !== right.kind) return false
  return left.kind !== 'field' || right.kind !== 'field' || left.key === right.key
}
function sortBy(sort: SortKey) {
  if (sameSort(query.value.sort, sort)) {
    query.value.direction = query.value.direction === 'asc' ? 'desc' : 'asc'
    return
  }
  query.value.sort = sort
  query.value.direction = sort.kind === 'received' ? 'desc' : 'asc'
}
function ariaSort(sort: SortKey): 'ascending' | 'descending' | 'none' {
  if (!sameSort(query.value.sort, sort)) return 'none'
  return query.value.direction === 'asc' ? 'ascending' : 'descending'
}
function toggleRow(id: string) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter(item => item !== id)
    : [...selectedIds.value, id]
}
function toggleAllVisible() {
  const ids = visibleRows.value.map(row => row.id)
  selectedIds.value = allVisibleSelected.value ? [] : ids
}
function bulk(next: SubmissionStatus) {
  const ids = [...selectedIds.value]
  selectedIds.value = []
  if (ids.length) emit('bulk-status', ids, next)
}
function askDelete(row: SubmissionRow) {
  confirmingDelete.value = row.id
}
function confirmDelete(row: SubmissionRow) {
  confirmingDelete.value = null
  emit('delete', row)
}
function statusClass(status: string): string {
  return status === 'new' || status === 'reviewed' || status === 'spam' ? `status-${status}` : ''
}
</script>

<template>
  <section class="submissions" aria-label="Form responses">
    <div class="table-controls">
      <fieldset class="status-filter">
        <legend>Status</legend>
        <label v-for="option in statusOptions" :key="option.value">
          <input type="checkbox" :checked="hasStatus(option.value)" :disabled="busy || locked" @change="onStatusChange(option.value, $event)">
          {{ option.label }}
        </label>
      </fieldset>
      <label class="date-filter">Received from (your time, {{ zoneName }})
        <input v-model="query.from" type="date" :disabled="busy || locked">
      </label>
      <label class="date-filter">Received to (your time, {{ zoneName }})
        <input v-model="query.to" type="date" :disabled="busy || locked">
      </label>
      <label class="search-filter">Search responses
        <input v-model="query.search" type="search" placeholder="Name, email, message…" :disabled="busy || locked">
      </label>
    </div>

    <div class="table-actions">
      <UButton color="neutral" variant="outline" :disabled="busy || !loadedCount" @click="emit('export')">Export all responses (CSV)</UButton>
      <p class="table-help">Times in the CSV are UTC. Filters are not applied to the export.</p>
    </div>

    <p v-if="hasMore" class="partial-notice" role="note">
      Sorting, filters and search apply to the {{ loadedCount }} responses loaded. More responses exist — load more to include them.
    </p>
    <p v-if="filtersHideRows" class="table-count" role="status">Showing {{ visibleCount }} of {{ loadedCount }} loaded</p>

    <div v-if="(canManage || canMarkNew) && selectedIds.length" class="bulk-bar" role="group" aria-label="Bulk response actions">
      <span>{{ selectedIds.length }} selected</span>
      <UButton v-if="canManage" color="neutral" variant="outline" :disabled="busy || locked" @click="bulk('reviewed')">Mark reviewed</UButton>
      <UButton v-if="canManage" color="neutral" variant="outline" :disabled="busy || locked" @click="bulk('spam')">Mark spam</UButton>
      <UButton v-if="canMarkNew" color="neutral" variant="outline" :disabled="busy || locked" @click="bulk('new')">Mark new</UButton>
    </div>

    <div class="table-scroll">
      <table :class="{ 'has-selection': canManage || canMarkNew }">
        <caption class="visually-hidden">Responses for this form. Sorting, filters and search apply to loaded rows only.</caption>
        <thead>
          <tr>
            <th v-if="canManage || canMarkNew" class="select-cell" scope="col">
              <input
                type="checkbox"
                aria-label="Select all visible responses"
                :checked="allVisibleSelected"
                :indeterminate.prop="someVisibleSelected && !allVisibleSelected"
                :disabled="busy || locked || !visibleCount"
                @change="toggleAllVisible"
              >
            </th>
            <th scope="col" :aria-sort="ariaSort({ kind: 'received' })">
              <button type="button" class="sort-button" @click="sortBy({ kind: 'received' })">Received</button>
            </th>
            <th scope="col" :aria-sort="ariaSort({ kind: 'status' })">
              <button type="button" class="sort-button" @click="sortBy({ kind: 'status' })">Status</button>
            </th>
            <th v-for="column in columns" :key="column.key" scope="col" :aria-sort="ariaSort({ kind: 'field', key: column.key })">
              <button type="button" class="sort-button" @click="sortBy({ kind: 'field', key: column.key })">{{ column.label }}</button>
            </th>
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in visibleRows" :key="row.id">
            <td v-if="canManage || canMarkNew" class="select-cell">
              <input type="checkbox" :aria-label="`Select response received ${formatInstant(row.received_at, { timeZone: zone })}`" :checked="selectedIds.includes(row.id)" :disabled="busy || locked" @change="toggleRow(row.id)">
            </td>
            <td class="time-cell">
              <time :datetime="row.received_at" :title="row.received_at">{{ formatInstant(row.received_at, { timeZone: zone }) }}</time>
            </td>
            <td class="status-cell"><span :class="['status-dot', statusClass(row.status)]" aria-hidden="true" />{{ row.status }}</td>
            <td v-for="column in columns" :key="column.key" class="value-cell">{{ row.values[column.key] ?? '' }}</td>
            <td class="row-action-cell">
              <details>
                <summary>View</summary>
                <dl class="row-values">
                  <template v-for="(value, key) in row.values" :key="key">
                    <dt>{{ key }}</dt>
                    <dd>{{ value }}</dd>
                  </template>
                </dl>
                <slot name="row-extra" :row="row" />
              </details>
              <details v-if="canManage || canMarkNew" class="row-actions">
                <summary :aria-label="`Actions for response received ${formatInstant(row.received_at, { timeZone: zone })}`">Actions</summary>
                <div class="row-actions-menu">
                  <UButton v-if="canMarkNew" color="neutral" variant="ghost" :disabled="busy || locked" @click="emit('status', row, 'new')">Mark new</UButton>
                  <UButton v-if="canManage" color="neutral" variant="ghost" :disabled="busy || locked" @click="emit('status', row, 'reviewed')">Mark reviewed</UButton>
                  <UButton v-if="canManage" color="neutral" variant="ghost" :disabled="busy || locked" @click="emit('status', row, 'spam')">Mark spam</UButton>
                  <UButton v-if="canManage" color="error" variant="ghost" :disabled="busy || locked" @click="askDelete(row)">Delete</UButton>
                  <div v-if="confirmingDelete === row.id" class="delete-confirm" role="group" aria-label="Confirm response deletion">
                    <p>Permanently delete this response and its notification history?</p>
                    <UButton color="error" :loading="busy" :disabled="busy || locked" @click="confirmDelete(row)">Delete response</UButton>
                    <UButton color="neutral" variant="outline" :disabled="busy" @click="confirmingDelete = null">Cancel</UButton>
                  </div>
                </div>
              </details>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="!visibleRows.length" class="empty-table">{{ loadedCount ? 'No responses match these filters.' : 'No responses to display.' }}</p>
    <UButton v-if="hasMore" color="neutral" variant="outline" :loading="loading" :disabled="loading" @click="emit('load-more')">Load next 100</UButton>
  </section>
</template>

<style scoped>
.submissions { display: grid; gap: 12px; min-width: 0; }
.table-controls { display: flex; flex-wrap: wrap; gap: 12px 18px; align-items: end; }
.status-filter { border: 0; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 6px 14px; }
.status-filter legend { font-size: 11px; color: var(--muted); padding: 0; margin-bottom: 4px; }
.status-filter label { display: inline-flex; gap: 6px; align-items: center; min-height: 32px; font-size: 13px; }
.date-filter, .search-filter { display: grid; gap: 4px; font-size: 11px; color: var(--muted); }
.date-filter input, .search-filter input { min-height: 38px; border: 1px solid var(--border); border-radius: 4px; background: #fff; color: var(--ink); padding: 6px 8px; font-size: 13px; }
.table-actions { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
.table-help { color: var(--muted); font-size: 12px; }
.partial-notice { background: var(--canvas); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; font-size: 12px; color: var(--muted); }
.table-count { color: var(--muted); font-size: 12px; }
.bulk-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--canvas); font-size: 12px; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { color: var(--muted); font-size: 11px; font-weight: 500; padding: 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
td { padding: 9px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
.sort-button { color: inherit; font: inherit; text-align: left; text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; min-height: 32px; }
.sort-button:hover { text-decoration-color: currentColor; }
.select-cell { width: 34px; }
.select-cell input { width: 18px; height: 18px; }
.time-cell time { white-space: nowrap; font-variant-numeric: tabular-nums; }
.status-cell { white-space: nowrap; text-transform: lowercase; }
.status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-right: 6px; }
.status-dot.status-new { background: var(--rust); }
.status-dot.status-reviewed { background: var(--ink); }
.status-dot.status-spam { background: var(--muted); }
.value-cell { max-width: 260px; overflow-wrap: anywhere; }
.row-action-cell { white-space: nowrap; }
.row-action-cell details { display: inline-block; margin-right: 8px; }
.row-action-cell summary { cursor: pointer; min-height: 32px; padding: 5px 0; }
.row-values { display: grid; grid-template-columns: minmax(80px, max-content) minmax(0, 1fr); gap: 4px 12px; min-width: 220px; margin-top: 6px; }
.row-values dt { color: var(--muted); font-weight: 600; }
.row-values dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.row-actions-menu { display: grid; gap: 4px; min-width: 170px; margin-top: 6px; }
.delete-confirm { border-top: 1px solid var(--border); padding-top: 8px; display: grid; gap: 6px; white-space: normal; }
.empty-table { color: var(--muted); font-size: 13px; padding: 12px 0; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (max-width: 650px) {
  .table-controls, .date-filter, .search-filter { width: 100%; }
  .date-filter input, .search-filter input { width: 100%; }
  .table-scroll { border: 1px solid var(--border); border-radius: 4px; }
  th:first-child, td:first-child { position: sticky; left: 0; background: #fff; z-index: 1; }
  table.has-selection th:nth-child(2), table.has-selection td:nth-child(2) { position: sticky; left: 34px; background: #fff; z-index: 1; }
  /* Narrow screens scroll the table instead of squeezing the text columns
     into mid-word wrapping; the sticky first column stays readable. */
  table { min-width: 720px; }
  .value-cell { min-width: 150px; max-width: 260px; }
}
</style>
