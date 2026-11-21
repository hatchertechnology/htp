<script setup lang="ts">
import type { AuditDetail } from '../../shared/types/seosmith'

defineProps<{ audit: AuditDetail }>()
function label(value: string) { return value.replaceAll('_', ' ') }
</script>

<template>
  <section class="report-panel seo-history-table" aria-labelledby="audit-coverage-title">
    <h3 id="audit-coverage-title">Evidence and coverage</h3>
    <p class="report-caption">Report schema {{ audit.summary.schema_version }} · summary version {{ audit.summary.summary_version ?? 'unknown' }} · evidence contract {{ audit.report.evidence_contract?.version ?? 'unavailable' }}.</p>
    <template v-if="audit.report.evidence_contract">
      <p class="report-caption">Observed {{ audit.report.evidence_contract.observed_at.started_at }} to {{ audit.report.evidence_contract.observed_at.finished_at }} · policy digest {{ audit.report.evidence_contract.policy.signature }}.</p>
      <p v-if="audit.report.evidence_contract.truncated" class="form-notice" role="status">Evidence was truncated; {{ audit.report.evidence_contract.omitted_observations }} observations were omitted. Missing evidence is unknown.</p>
      <div v-if="audit.report.evidence_contract.coverage.length" class="table-scroll">
        <table>
          <caption>Rule coverage in the saved report</caption>
          <thead><tr><th scope="col">Rule</th><th scope="col">Entities</th><th scope="col">Eligible</th><th scope="col">Ineligible</th><th scope="col">Eligibility unknown</th><th scope="col">Attempted</th><th scope="col">Not attempted</th><th scope="col">Attempt unknown</th><th scope="col">Passed</th><th scope="col">Failed</th><th scope="col">Not applicable</th><th scope="col">Outcome unknown</th><th scope="col">Unknown reasons</th></tr></thead>
          <tbody><tr v-for="row in audit.report.evidence_contract.coverage" :key="row.rule"><th scope="row">{{ label(row.rule) }}</th><td>{{ row.entities }}</td><td>{{ row.eligible }}</td><td>{{ row.ineligible }}</td><td>{{ row.eligibility_unknown }}</td><td>{{ row.attempted }}</td><td>{{ row.not_attempted }}</td><td>{{ row.attempt_unknown }}</td><td>{{ row.passed }}</td><td>{{ row.failed }}</td><td>{{ row.not_applicable }}</td><td>{{ row.unknown }}</td><td><span v-if="!Object.keys(row.unknown_reasons).length">None reported</span><span v-for="(count, reason) in row.unknown_reasons" :key="reason">{{ label(String(reason)) }}: {{ count }}<br></span></td></tr></tbody>
        </table>
      </div>
      <p v-else class="report-caption">No rule coverage rows were reported.</p>
    </template>
    <p v-else class="report-caption">Per-rule coverage and evidence provenance are unavailable for this report. An absent finding does not establish a pass.</p>
  </section>
</template>
