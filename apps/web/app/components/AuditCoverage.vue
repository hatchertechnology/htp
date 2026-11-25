<script setup lang="ts">
import type { AuditDetail } from '../../shared/types/seosmith'
import { formatInstant } from '#shared/utils/local-time'

defineProps<{ audit: AuditDetail }>()
function state(value: boolean | null | undefined) { return value === true ? 'Complete' : value === false ? 'Partial' : 'Unknown' }
function label(value: string) { return value.replaceAll('_', ' ') }
</script>

<template>
  <section class="report-panel seo-history-table" aria-labelledby="audit-coverage-title">
    <h3 id="audit-coverage-title">Evidence and coverage</h3>
    <p class="report-caption">Report schema {{ audit.summary.schema_version }} · summary version {{ audit.summary.summary_version ?? 'unknown' }} · evidence contract {{ audit.report.evidence_contract?.version ?? 'unavailable' }}.</p>
    <p class="report-caption">Delivery {{ audit.delivery_id }} · {{ audit.ingestion_source === 'import' ? 'Imported report' : audit.ingestion_source === 'worker' ? 'Worker delivery' : 'Source unavailable' }} · received <time :datetime="audit.received_at" :title="audit.received_at">{{ formatInstant(audit.received_at) }}</time>.</p>
    <p class="report-caption">Crawl coverage: {{ state(audit.report.schema_version === 1 ? audit.summary.coverage_complete : (audit.report.schema_version === 2 || audit.report.schema_version === 4) && audit.report.evidence_contract?.version === 1 ? audit.summary.crawl_coverage_complete : null) }} · Evaluation coverage: {{ state((audit.report.schema_version === 2 || audit.report.schema_version === 4) && audit.report.evidence_contract?.version === 1 ? audit.report.evidence_contract.evaluation_coverage_complete : null) }}.</p>
    <p class="report-caption">Coverage counts describe stored report observations, not the whole website. An absent finding does not establish a pass.</p>
    <template v-if="(audit.report.schema_version === 2 || audit.report.schema_version === 4) && audit.report.evidence_contract?.version === 1">
      <p class="report-caption">Observed <time :datetime="audit.report.evidence_contract.observed_at.started_at" :title="audit.report.evidence_contract.observed_at.started_at">{{ formatInstant(audit.report.evidence_contract.observed_at.started_at) }}</time> to <time :datetime="audit.report.evidence_contract.observed_at.finished_at" :title="audit.report.evidence_contract.observed_at.finished_at">{{ formatInstant(audit.report.evidence_contract.observed_at.finished_at) }}</time> · policy digest {{ audit.report.evidence_contract.policy.signature }} (unauthenticated SHA-256 digest).</p>
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
    <p v-else class="report-caption">Per-rule coverage and evidence provenance are unavailable or unsupported for this report.</p>
  </section>
</template>
