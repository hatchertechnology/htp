<script setup lang="ts">
import type { AuditDetail } from '../../shared/types/seosmith'
import {
  SCHEMA4_SUMMARY_VERSION,
  auditCoverageLabel,
  digestStatus,
  labelRule,
  recordCounts,
  reportExport,
  ruleClaim,
  ruleClaimLabels,
  ruleClaimTotals,
  semanticsSupport,
  sha256Hex,
  summaryExport,
  type DigestStatus,
  type SummaryExportReason,
} from '#shared/utils/saved-semantics'

const props = defineProps<{ audit: AuditDetail }>()
const summary = computed(() => props.audit.summary)
const support = computed(() => semanticsSupport(summary.value))
const shownSummary = computed(() => support.value === 'schema4-summary5' ? summary.value : null)
const counts = computed(() => recordCounts(shownSummary.value?.record_counts))
const totals = computed(() => ruleClaimTotals(shownSummary.value?.rule_coverage))
// A summary may omit `rule_coverage` entirely. That is unavailable coverage,
// not a population of verified-clean rules, so the all-clean sentence must be
// gated on an actual verified population.
const hasRuleCoverage = computed(() => totals.value.rules > 0)
const claims = computed(() => Object.entries(shownSummary.value?.rule_coverage ?? {})
  .map(([rule, coverage]) => ({ rule, coverage, claim: ruleClaim(coverage) }))
  .sort((a, b) => a.claim.localeCompare(b.claim) || a.rule.localeCompare(b.rule)))
const showAllRules = ref(false)
// Verified-clean rules are summarised by count; rules with findings or unknown
// coverage stay visible because those are the claims a reader must weigh.
const visibleClaims = computed(() => showAllRules.value ? claims.value : claims.value.filter(entry => entry.claim !== 'verified-clean'))
const omitted = computed(() => (shownSummary.value?.omitted_records ?? 0) + (shownSummary.value?.omitted_observations ?? 0))
function stamp(value: string | null | undefined) { return value ? `${value.replace('T', ' ').replace('Z', '')} UTC` : 'Unavailable' }
// The receiver emits an opaque summary text. We hash those exact bytes when the
// detail retains them, and separately hash the retained report export. A parsed
// summary object is not receiver-canonical: JSONB and object handling may
// reorder keys, so its serialization is a reconstruction and its digest must
// never be compared with the receiver's stored summary digest.
const retainedSummary = computed(() => summaryExport(props.audit))
const summaryDigest = ref<{ hex: string | null; bytes: number; exact: boolean; reason: SummaryExportReason | null; status: DigestStatus | null } | null>(null)
const reportDigest = ref<{ hex: string | null; bytes: number; exact: boolean; status: DigestStatus | null } | null>(null)
let digestGeneration = 0
watch(() => props.audit.delivery_id, async () => {
  const generation = ++digestGeneration
  summaryDigest.value = null; reportDigest.value = null
  if (support.value !== 'schema4-summary5') return
  const summaryBytes = summaryExport(props.audit)
  const exported = reportExport(props.audit)
  const [summaryHex, reportHex] = await Promise.all([sha256Hex(summaryBytes.text), sha256Hex(exported.text)])
  if (generation !== digestGeneration) return
  summaryDigest.value = {
    hex: summaryHex,
    bytes: new TextEncoder().encode(summaryBytes.text).length,
    exact: summaryBytes.exact,
    reason: summaryBytes.reason,
    status: summaryBytes.exact ? digestStatus(summaryHex, props.audit.summary_sha256) : null,
  }
  reportDigest.value = {
    hex: reportHex,
    bytes: new TextEncoder().encode(exported.text).length,
    exact: exported.exact,
    status: exported.exact ? digestStatus(reportHex, props.audit.source_sha256) : null,
  }
}, { immediate: true })
function downloadSummary() {
  // Exact retained receiver text when present; otherwise an explicitly
  // reconstructed serialization that must not be compared to the stored digest.
  const retained = summaryExport(props.audit)
  const url = URL.createObjectURL(new Blob([retained.text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = retained.exact
    ? `seosmith-summary-${props.audit.delivery_id}.json`
    : `seosmith-summary-${props.audit.delivery_id}-reconstructed.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <section v-if="support === 'schema4-summary5'" class="report-panel seo-history-table" aria-labelledby="audit-semantics-title">
    <header>
      <div><h3 id="audit-semantics-title">Receiver-verified semantics</h3><p class="report-caption">Schema {{ shownSummary?.schema_version }} summary version {{ shownSummary?.summary_version }} · wire contract {{ shownSummary?.wire_contract_version || 'unavailable' }} · evidence state {{ shownSummary?.evidence_state || 'unavailable' }}. Derived by the receiver from the retained report; not a re-crawl.</p></div>
      <button class="refresh-control" @click="downloadSummary">{{ retainedSummary.exact ? 'Download receiver summary' : 'Download reconstructed summary' }}</button>
    </header>
    <p v-if="shownSummary?.coverage_complete === true" class="form-notice" role="status">Audit coverage: Complete verified. The whole expected finding population was independently reproduced for the retained evidence. A complete audit does not imply every rule is complete, and it does not mean the site is clean.</p>
    <p v-else class="form-notice" role="status">Audit coverage: {{ auditCoverageLabel(shownSummary?.audit_coverage) }}. Some checks did not complete, so a missing finding is unknown, not a pass.</p>
    <p v-if="omitted" class="form-notice" role="status">{{ shownSummary?.omitted_records ?? 0 }} records and {{ shownSummary?.omitted_observations ?? 0 }} observations were omitted; omitted evidence is unknown.</p>
    <div class="table-scroll">
      <table>
        <caption>Receiver record counts for this run</caption>
        <thead><tr><th scope="col">Record outcome</th><th scope="col">Count</th></tr></thead>
        <tbody><tr v-for="row in counts" :key="row.key"><th scope="row">{{ row.label }}</th><td :data-record-count="row.key">{{ row.count }}</td></tr></tbody>
      </table>
    </div>
    <p class="report-caption">An advisory is a threshold observation; a policy violation requires explicit intent. Neither is inferred from an absent finding.</p>
    <div class="table-scroll">
      <table>
        <caption>Retained observations and provenance</caption>
        <thead><tr><th scope="col">Pages checked</th><th scope="col">HTML pages</th><th scope="col">Resources</th><th scope="col">HTTP / fetch errors</th><th scope="col">Crawl coverage</th><th scope="col">Evaluation coverage</th></tr></thead>
        <tbody><tr>
          <td>{{ shownSummary?.pages.checked ?? 0 }}</td>
          <td>{{ shownSummary?.pages.html ?? 0 }}</td>
          <td>{{ shownSummary?.resources?.checked ?? 'Unavailable' }}</td>
          <td>{{ shownSummary?.pages.http_errors ?? 0 }} / {{ shownSummary?.pages.fetch_errors ?? 0 }}</td>
          <td>{{ shownSummary?.crawl_coverage_complete === true ? 'Complete' : shownSummary?.crawl_coverage_complete === false ? 'Partial' : 'Unknown' }}</td>
          <td>{{ shownSummary?.evaluation_coverage_complete === true ? 'Complete' : shownSummary?.evaluation_coverage_complete === false ? 'Partial' : 'Unknown' }}</td>
        </tr></tbody>
      </table>
    </div>
    <details>
      <summary>Provenance and raw digests</summary>
      <p class="report-caption">Delivery {{ audit.delivery_id }} · {{ audit.ingestion_source === 'import' ? 'Imported report' : audit.ingestion_source === 'worker' ? 'Worker delivery' : 'Source unavailable' }} · received {{ stamp(audit.received_at) }} · engine {{ shownSummary?.engine_version || 'unknown' }} · ruleset {{ shownSummary?.ruleset_version || 'unknown' }} · observed {{ stamp(shownSummary?.started_at) }} to {{ stamp(shownSummary?.finished_at) }} · outcome {{ shownSummary?.stop_reason || shownSummary?.outcome }}.</p>
      <p class="report-caption">Policy digest {{ shownSummary?.policy_digest || 'Unavailable' }} · manifest digest {{ shownSummary?.manifest_digest || 'Unavailable' }} · scope digest {{ shownSummary?.scope_digest || 'Unavailable' }} · comparison key {{ shownSummary?.comparison_key || 'Unavailable' }}. These SHA-256 digests bind the declared policy, manifest and scope; they do not authenticate the raw source bytes.</p>
      <p v-if="summaryDigest?.exact" class="report-caption">Retained summary text SHA-256 {{ summaryDigest.hex || 'unavailable' }} · {{ summaryDigest.bytes ?? 'unknown' }} bytes computed over the exact opaque summary text stored with this detail. Stored summary binding: {{ audit.summary_sha256 || 'not stored with this detail' }}<template v-if="audit.summary_bytes !== undefined"> · {{ audit.summary_bytes }} bytes</template>. The computed digest {{ summaryDigest.status === 'match' ? 'matches the stored summary digest' : summaryDigest.status === 'mismatch' ? 'does not match the stored summary digest' : summaryDigest.status === 'unavailable' ? 'could not be computed because Web Crypto is unavailable, so the comparison is unknown' : 'has no stored summary digest to compare against' }}. It binds the summary content only and is not the source report digest.</p>
      <p v-else class="report-caption">Retained summary text is {{ summaryDigest?.reason === 'invalid' ? 'present but not a valid summary object' : 'not stored with this detail' }}. The summary SHA-256 {{ summaryDigest?.hex || 'unavailable' }} · {{ summaryDigest?.bytes ?? 'unknown' }} bytes is computed over a reconstructed JSON serialization of the parsed summary, not the receiver's bytes. It is not receiver-canonical and must not be compared with the stored summary digest.</p>
      <p v-if="reportDigest?.exact" class="report-caption">Retained source binding: {{ audit.source_sha256 || 'not stored with this detail' }}<template v-if="audit.source_bytes !== undefined"> · {{ audit.source_bytes }} bytes</template>. This binding is stored separately from the summary. The exact retained report bytes are present with this detail, so the run JSON download is byte-identical and its SHA-256 {{ reportDigest.status === 'match' ? 'matches this binding' : reportDigest.status === 'mismatch' ? 'does not match this binding' : reportDigest.status === 'unavailable' ? 'could not be computed because Web Crypto is unavailable, so the comparison is unknown' : 'has no stored source digest to compare against' }}.</p>
      <p v-else class="report-caption">Retained source binding: {{ audit.source_sha256 || 'not stored with this detail' }}<template v-if="audit.source_bytes !== undefined"> · {{ audit.source_bytes }} bytes</template>. This binding is stored separately from the summary, but the raw report bytes are not retained with this detail. The run JSON download is a reconstructed export from the parsed report and cannot be compared to this source digest as retained bytes.<template v-if="summaryDigest?.exact"> Only the retained summary text digest above is reproducible.</template><template v-else> Neither the summary nor the report digest above is reproducible from receiver bytes.</template></p>
    </details>
    <details open>
      <summary>Per-rule claim scope ({{ hasRuleCoverage ? `${totals.rules} rules` : 'unavailable' }})</summary>
      <p v-if="hasRuleCoverage" class="report-caption">{{ totals.verified }} verified clean within retained scope · {{ totals.findings }} with a finding · {{ totals.unknown }} unknown. A verified-clean rule reproduced its expected population and is not an inference from absence; it does not imply the report is globally clean. Unknown rules cannot support a pass.</p>
      <p v-else class="report-caption">Per-rule coverage is unavailable: this summary reports no rule coverage entries, so no rule can be shown as verified clean or unknown. Absence of a rule is not a pass.</p>
      <div v-if="hasRuleCoverage" class="table-scroll">
        <table>
          <caption>Per-rule receiver claim scope</caption>
          <thead><tr><th scope="col">Rule</th><th scope="col">Claim</th><th scope="col">Reported findings</th></tr></thead>
          <tbody><tr v-for="entry in visibleClaims" :key="entry.rule"><th scope="row">{{ labelRule(entry.rule) }}</th><td>{{ ruleClaimLabels[entry.claim] }}</td><td>{{ entry.coverage.reported_findings }}</td></tr></tbody>
        </table>
      </div>
      <p v-if="totals.verified > 0 && !visibleClaims.length" class="compact-empty">Every reported rule is verified clean within retained scope.</p>
      <button v-if="totals.verified" class="refresh-control" @click="showAllRules = !showAllRules">{{ showAllRules ? `Hide ${totals.verified} verified-clean rules` : `Show ${totals.verified} verified-clean rules` }}</button>
    </details>
    <p class="report-caption">A receiver-verified summary describes the retained report only. It does not establish source truth, unobserved pages, crawler completeness or current site state.</p>
  </section>
  <section v-else-if="support === 'schema4-unsupported'" class="report-panel" aria-labelledby="audit-semantics-title">
    <h3 id="audit-semantics-title">Receiver-verified semantics</h3>
    <p class="form-notice" role="status">This schema 4 run has summary version {{ summary.summary_version ?? 'unknown' }}; only version {{ SCHEMA4_SUMMARY_VERSION }} is supported here. No coverage or finding-semantics claims are shown. Download the raw report to inspect it.</p>
  </section>
</template>
