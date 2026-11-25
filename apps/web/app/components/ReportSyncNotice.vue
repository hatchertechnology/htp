<script setup lang="ts">
import type { SyncStatus } from '../../shared/types/sync'
import { formatInstant } from '#shared/utils/local-time'
defineProps<{ sync?: SyncStatus | null; label?: string; provider?: string }>()
</script>
<template>
  <p v-if="sync" class="report-caption" role="status">
    <strong v-if="label">{{ label }} · </strong>
    <template v-if="sync.fetched_at">Last synced <time :datetime="sync.fetched_at" :title="sync.fetched_at">{{ formatInstant(sync.fetched_at) }}</time> · Updates {{ sync.cadence || 'hourly' }}.</template>
    <template v-else>No saved observations for this selection. Collection runs on its own schedule.</template>
    <span v-if="sync.coverage">Stored coverage: {{ sync.coverage.state }} · {{ sync.coverage.observed_days }} observed days. Additive totals use available days only.</span>
    <span v-if="sync.coverage?.missing_dates.length">Missing dates: {{ sync.coverage.missing_dates.join(', ') }}.</span>
    <span v-if="sync.coverage && !sync.exact_range_available && provider !== 'Bing'">Unique users, rates, rankings and breakdowns are unavailable without an exact-range report.</span>
    <span v-if="sync.observation_kind === 'lab_run'">Latest saved lab run; independent of the selected dates.</span>
    <span v-if="sync.observation_kind === 'rolling_period'">Latest saved CrUX rolling collection period; independent of the selected dates.</span>
    <span v-if="sync.connection_status === 'reauthorization_required'">Reconnect {{ provider || 'Google' }} under Connections to resume updates. Saved reports remain available.</span>
    <span v-else-if="!sync.connection_status || sync.connection_status === 'disconnected'">Connect {{ provider || 'Google' }} to start scheduled updates.</span>
    <span v-else-if="sync.last_error === 'integration_not_configured'">An administrator needs to configure this integration’s API key.</span>
    <span v-else-if="sync.last_error">The latest sync failed. We’ll retry automatically{{ sync.fetched_at ? '; showing the last successful report' : '' }}.</span>
    <span v-else-if="sync.state === 'stale'">The saved report is older than expected. The next sync is pending.</span>
  </p>
</template>
