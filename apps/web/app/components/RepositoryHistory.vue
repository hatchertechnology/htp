<script setup lang="ts">
const ws = useWorkspace()
const { start, end, includeToday } = useReportRange()
const { history, busy, error, load } = useRepositoryHistory(() => ws.selectedId.value, () => start.value, () => end.value)
const binding = computed(() => history.value?.repository)
const commits = computed(() => [...(history.value?.commits ?? [])].sort((a, b) => b.committed_at.localeCompare(a.committed_at)))
const errors: Record<string, string> = {
  github_rate_limited: 'GitHub’s request limit was reached. Collection will retry automatically.',
  github_repository_not_public_or_missing: 'The repository is missing or is not public. Check its URL and visibility.',
  github_unavailable: 'GitHub could not be reached. Collection will retry automatically.',
}
</script>
<template>
  <section class="insight-section" aria-labelledby="repository-title" :aria-busy="busy">
    <div class="analytics-section-heading"><div><h2 id="repository-title">Website change history</h2><p>GitHub commits alongside your selected reporting dates</p></div><button v-if="ws.selectedId.value && ws.user.value" class="refresh-control" :disabled="busy" @click="load()">Reload saved history</button></div>
    <p v-if="error" role="alert" class="form-error">{{ error }} <button @click="load()">Try again</button></p>
    <template v-if="binding">
      <p class="report-caption"><a :href="binding.repository_url" target="_blank" rel="noopener noreferrer">{{ binding.repository_url.replace('https://github.com/', '') }}</a> · {{ binding.branch || 'Default branch' }} · {{ binding.enabled ? 'Hourly collection' : 'Collection paused' }}<span v-if="binding.last_checked_at">Last checked {{ new Date(binding.last_checked_at).toLocaleString() }}</span><span v-else>Waiting for the first collection.</span><span v-if="binding.backfilling">Collecting older commits in batches.</span></p>
      <p v-if="binding.last_error" class="form-notice">{{ errors[binding.last_error] || 'Repository collection could not finish. Check the repository settings; collection will retry automatically.' }}</p>
      <div class="report-panel table-scroll"><table class="repository-history-table"><thead><tr><th>Committed (UTC)</th><th>Change</th><th>Author</th><th>First observed (UTC)</th></tr></thead><tbody><tr v-for="commit in commits" :key="commit.id"><td>{{ new Date(commit.committed_at).toISOString().replace('T', ' ').slice(0, 19) }}</td><td><a :href="`${commit.repository_url}/commit/${commit.sha}`" target="_blank" rel="noopener noreferrer">{{ commit.message.split('\n')[0] }}</a><small>{{ commit.sha.slice(0, 7) }} · {{ commit.repository_url.replace('https://github.com/', '') }} · {{ commit.branch || 'Default branch' }}</small></td><td>{{ commit.author || 'Unknown' }}</td><td>{{ new Date(commit.observed_at).toISOString().replace('T', ' ').slice(0, 19) }}</td></tr></tbody></table><p v-if="!commits.length" class="compact-empty">{{ busy ? 'Reading saved commit history…' : 'No commits collected for these dates. Try a wider date range or include today.' }}</p></div>
      <button v-if="history?.has_more" class="refresh-control" :disabled="busy" @click="load(true)">Load older observations</button>
      <button class="refresh-control" @click="includeToday">Include today in date range</button>
      <p class="report-caption">Dates use UTC. Commits show repository changes, not confirmed deployments. Backfilled commits retain their original dates and the time Hatch first observed them. Changes from previous repository links remain in history for this FQDN.</p>
    </template>
    <p v-else class="compact-empty">{{ busy ? 'Reading repository settings…' : 'Link a public GitHub repository under Websites to track changes alongside website performance.' }} <NuxtLink to="/websites">Manage websites</NuxtLink></p>
  </section>
</template>
