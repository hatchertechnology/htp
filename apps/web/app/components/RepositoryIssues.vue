<script setup lang="ts">
const { ws, state, result, busy, error, load } = useRepositoryIssues()
</script>

<template>
  <section class="insight-section" aria-labelledby="issues-title" :aria-busy="busy">
    <div class="analytics-section-heading">
      <div><h2 id="issues-title">HTP issues</h2><p>GitHub issues labeled HTP · Independent of reporting dates</p></div>
      <button v-if="ws.user.value && ws.selectedId.value" class="refresh-control" :disabled="busy" @click="load()">Refresh issues</button>
    </div>
    <template v-if="ws.user.value && ws.selectedId.value">
      <div class="issues-controls">
        <label for="issues-state">Issue status</label>
        <select id="issues-state" v-model="state"><option value="open">Open</option><option value="closed">Closed</option><option value="all">All issues</option></select>
        <a v-if="result?.repository_url" :href="`${result.repository_url}/issues?q=is%3Aissue+label%3AHTP${state === 'all' ? '' : `+is%3A${state}`}`" target="_blank" rel="noopener noreferrer">View on GitHub</a>
      </div>
      <p v-if="error" role="alert" class="form-error">{{ error }} <button :disabled="busy" @click="load()">Try again</button></p>
      <p v-if="busy && !result" class="compact-empty" role="status">Loading HTP issues…</p>
      <template v-if="result?.repository_url">
        <p class="report-caption">{{ result.repository_url.replace('https://github.com/', '') }} · Most recently updated first</p>
        <div v-if="result.issues.length" class="report-panel table-scroll">
          <table class="repository-issues-table"><caption class="sr-only">GitHub issues labeled HTP</caption><thead><tr><th scope="col">Issue</th><th scope="col">Status</th><th scope="col">Updated</th></tr></thead>
            <tbody><tr v-for="issue in result.issues" :key="issue.number"><td><a :href="issue.url" target="_blank" rel="noopener noreferrer">#{{ issue.number }} · {{ issue.title }}</a></td><td>{{ issue.state === 'open' ? 'Open' : 'Closed' }}</td><td><time :datetime="issue.updated_at">{{ new Date(issue.updated_at).toLocaleDateString() }}</time></td></tr></tbody>
          </table>
        </div>
        <p v-else-if="!busy && !error" class="compact-empty">{{ result.has_more ? 'No matching issues on this page. Load more to continue.' : `No ${state === 'all' ? '' : `${state} `}issues labeled HTP in this repository.` }}</p>
        <UButton v-if="result.has_more" class="issues-load-more" variant="outline" color="neutral" :loading="busy" @click="load(true)">Load more issues</UButton>
      </template>
      <p v-else-if="result && !error" class="compact-empty">Link a public GitHub repository for this website to see its HTP issues. <NuxtLink to="/websites">Manage websites</NuxtLink></p>
    </template>
    <p v-else class="compact-empty">{{ ws.user.value ? 'Select a website to see its HTP issues.' : 'Sign in and select a website to see its HTP issues.' }}</p>
  </section>
</template>
