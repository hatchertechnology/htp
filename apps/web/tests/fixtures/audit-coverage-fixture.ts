import { createApp, h, ref } from 'vue'
import AuditCoverage from '../../app/components/AuditCoverage.vue'
const audit = ref<any>({ summary: { schema_version: 1 }, report: {} })
createApp({ render: () => h(AuditCoverage, { audit: audit.value }) }).mount('#app')
Object.assign(globalThis, { setCoverageFixture: (versioned: boolean) => {
  audit.value = versioned ? { summary: { schema_version: 2, summary_version: 3 }, report: { schema_version: 2, evidence_contract: {
    version: 1, observed_at: { started_at: '2026-11-01T00:00:00Z', finished_at: '2026-11-01T01:00:00Z' }, policy: { signature: 'fixture-digest' }, truncated: true, omitted_observations: 2,
    coverage: [{ rule: 'missing_title', entities: 5, eligible: 3, ineligible: 1, eligibility_unknown: 1, attempted: 2, not_attempted: 1, attempt_unknown: 0, passed: 1, failed: 1, not_applicable: 0, unknown: 1, unknown_reasons: { blocked: 1 } }],
  } } } : { summary: { schema_version: 1 }, report: {} }
} })
