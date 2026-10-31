<script setup lang="ts">
import type { SyncStatus } from '../../shared/types/sync'
defineProps<{ sync?: SyncStatus | null; label?: string; provider?: string }>()
</script>
<template>
  <p v-if="sync" class="report-caption" role="status">
    <strong v-if="label">{{ label }} · </strong>
    <template v-if="sync.fetched_at">Last synced {{ new Date(sync.fetched_at).toLocaleString() }} · Updates {{ sync.cadence || 'hourly' }}.</template>
    <template v-else>First sync queued. Reports usually appear within a few minutes.</template>
    <span v-if="sync.connection_status === 'reauthorization_required'">Reconnect {{ provider || 'Google' }} under Connections to resume updates. Saved reports remain available.</span>
    <span v-else-if="!sync.connection_status || sync.connection_status === 'disconnected'">Connect {{ provider || 'Google' }} to start scheduled updates.</span>
    <span v-else-if="sync.last_error === 'integration_not_configured'">An administrator needs to configure this integration’s API key.</span>
    <span v-else-if="sync.last_error">The latest sync failed. We’ll retry automatically{{ sync.fetched_at ? '; showing the last successful report' : '' }}.</span>
    <span v-else-if="sync.state === 'stale'">The saved report is older than expected. The next sync is pending.</span>
  </p>
</template>
