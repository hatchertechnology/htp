import type { AuditDetail, AuditEvaluation, AuditReport } from '../types/seosmith'
import { safeAuditUrl } from './seosmith'
import { findingPresentation } from './saved-semantics'

/** Only the unique explicit failed evaluation for this exact saved finding is attributed. */
export function findingEvaluation(report: AuditReport, index: number): AuditEvaluation | undefined {
  const finding = report.findings[index]
  if (!finding) return undefined
  // Missing provenance is not schema 1 evidence. Only an exact supported
  // contract version can support an attributed evaluation.
  if (report.evidence_contract?.version !== 1 || !Array.isArray(report.evidence_contract.evaluations)) return undefined
  const matches = report.evidence_contract.evaluations.filter(item =>
    item.finding_key === finding.key && item.source_locator === `/findings/${index}` && item.outcome === 'fail')
  return matches.length === 1 ? matches[0] : undefined
}

function evaluationProvenance(evaluation: AuditEvaluation): boolean {
  return [evaluation.rule, evaluation.rule_version, evaluation.validator_version, evaluation.source_locator]
    .every(value => typeof value === 'string' && value.length > 0)
}

/** Confidence is certified only by an exact high-confidence, fully attributed failed evaluation. */
export function findingConfidence(report: AuditReport, index: number): 'high' | undefined {
  const evaluation = findingEvaluation(report, index)
  return evaluation && evaluationProvenance(evaluation) && evaluation.confidence === 'high' ? 'high' : undefined
}

/**
 * H04 keeps technical severity, confidence, affected reach and intended policy
 * separate. Evidence-derived inputs are reported only when the saved report
 * establishes them; otherwise they stay explicitly unknown or unavailable.
 * This is a versioned display basis, never a score, ordering weight or revenue
 * estimate. Business exposure, effort and recommendation rationale are
 * owner-entered planning fields handled by the mutable work record.
 */
export const priorityVersion = 'h04-priority-1'
export type PriorityState = 'known' | 'unknown' | 'unavailable'
export interface PriorityInput {
  key: 'severity' | 'confidence' | 'reach' | 'policy'
  label: string
  state: PriorityState
  /** Only set for a known input; unknown and unavailable inputs never invent a value. */
  value: string | null
  /** Provenance for a known value, or the exact reason it is not established. */
  basis: string
}
export interface FindingPriority {
  version: typeof priorityVersion
  inputs: PriorityInput[]
  /** Composed record of the separate inputs. It is not a scalar priority. */
  rationale: string
}

function severityInput(detail: AuditDetail, index: number): PriorityInput {
  const finding = detail.report.findings[index]
  if (!finding) return { key: 'severity', label: 'Technical severity', state: 'unknown', value: null, basis: `No saved finding exists at /findings/${index}.` }
  const { origin, severity } = findingPresentation(detail, finding)
  if (severity === null) return { key: 'severity', label: 'Technical severity', state: 'unavailable', value: null, basis: origin ?? 'Technical severity unavailable.' }
  return { key: 'severity', label: 'Technical severity', state: 'known', value: severity, basis: `Technical severity recorded by the producer for rule ${finding.rule}.` }
}

function confidenceInput(report: AuditReport, index: number): PriorityInput {
  const evaluation = findingEvaluation(report, index)
  if (!evaluation) return { key: 'confidence', label: 'Evidence confidence', state: 'unknown', value: null, basis: `No unique explicit failed evaluation points to saved finding /findings/${index}; legacy, missing provenance or ambiguous evidence.` }
  if (!evaluationProvenance(evaluation)) return { key: 'confidence', label: 'Evidence confidence', state: 'unknown', value: null, basis: `The evaluation for /findings/${index} lacks complete rule, validator or source provenance, so its confidence is not certified.` }
  const basis = `Unique explicit failed ${evaluation.rule} evaluation (${evaluation.rule_version}, validator ${evaluation.validator_version}) at ${evaluation.source_locator}.`
  if (findingConfidence(report, index) === 'high') return { key: 'confidence', label: 'Evidence confidence', state: 'known', value: 'high', basis }
  const recorded = typeof evaluation.confidence === 'string' && evaluation.confidence ? evaluation.confidence : 'missing'
  return { key: 'confidence', label: 'Evidence confidence', state: 'unknown', value: null, basis: `The unique explicit failed ${evaluation.rule} evaluation records confidence as ${recorded}, not exact high (${evaluation.rule_version}, validator ${evaluation.validator_version}); confidence is not certified.` }
}

function coverageLabel(value: boolean | null | undefined): string {
  return value === true ? 'complete' : value === false ? 'incomplete' : 'unknown'
}

/**
 * Use only the receiver-derived coverage stored on AuditDetail.summary. A raw
 * legacy report claim is not enough, and an unsupported evidence contract does
 * not expose a summary coverage decision.
 */
function savedCoverage(detail: AuditDetail): { complete: boolean; basis: string } {
  const { report, summary } = detail
  if (report.schema_version === 1) {
    return summary.coverage_complete === true
      ? { complete: true, basis: 'saved receiver summary reports complete crawl coverage' }
      : { complete: false, basis: `saved receiver summary reports crawl coverage ${coverageLabel(summary.coverage_complete)}` }
  }
  // Schema 4 reads the receiver's v5 summary; other summary versions are not verified here.
  if ((report.schema_version === 2 || (report.schema_version === 4 && summary.summary_version === 5)) && report.evidence_contract?.version === 1) {
    const crawl = summary.crawl_coverage_complete
    const evaluation = summary.evaluation_coverage_complete
    return crawl === true && evaluation === true
      ? { complete: true, basis: 'saved receiver summary reports complete crawl and evaluation coverage' }
      : { complete: false, basis: `saved receiver summary reports crawl coverage ${coverageLabel(crawl)} and evaluation coverage ${coverageLabel(evaluation)}` }
  }
  return { complete: false, basis: `saved receiver summary has no crawl or evaluation coverage decision for report schema ${report.schema_version ?? 'unknown'}` }
}

function reachInput(detail: AuditDetail, finding: AuditReport['findings'][number] | undefined, index: number): PriorityInput {
  if (!finding) return { key: 'reach', label: 'Affected reach', state: 'unknown', value: null, basis: `No saved finding exists at /findings/${index}.` }
  const observed = new Set<string>()
  let invalid = 0
  for (const item of detail.report.findings) {
    if (item.rule !== finding.rule) continue
    const url = typeof item.url === 'string' ? safeAuditUrl(item.url) : undefined
    if (url) observed.add(url)
    else invalid += 1
  }
  const count = observed.size
  const coverage = savedCoverage(detail)
  const countBasis = `${count} distinct observed saved URL(s) share rule ${finding.rule}`
  const invalidBasis = invalid ? `; ${invalid} matching saved finding(s) have an invalid or missing URL and are excluded` : ''
  if (coverage.complete && invalid === 0) {
    return { key: 'reach', label: 'Affected reach', state: 'known', value: String(count), basis: `${countBasis}, and the ${coverage.basis}. This is an observed saved-report count, not a website-wide total.` }
  }
  return { key: 'reach', label: 'Affected reach', state: 'unknown', value: null, basis: `${coverage.basis}. ${countBasis}${invalidBasis}. This observed count is a lower bound only; website-wide reach is unknown.` }
}

function policyInput(report: AuditReport): PriorityInput {
  const contract = report.evidence_contract
  if (contract?.version === 1 && contract.policy) {
    let label = ''
    try {
      const canonical = JSON.parse(contract.policy.canonical_json) as Record<string, unknown>
      const version = typeof canonical.policy_version === 'string' ? canonical.policy_version : ''
      const ruleset = typeof canonical.ruleset_version === 'string' ? canonical.ruleset_version : ''
      label = [version, ruleset].filter(Boolean).join(' / ')
    } catch { label = '' }
    const signature = contract.policy.signature ? ` signature ${contract.policy.signature.slice(0, 16)}…` : ''
    return { key: 'policy', label: 'Intended policy', state: 'unavailable', value: null, basis: `This report carries collection policy${label ? ` ${label}` : ''}${signature}, which describes how evidence was gathered rather than the owner's intended page policy. Intended policy needs H02/S14.` }
  }
  return { key: 'policy', label: 'Intended policy', state: 'unavailable', value: null, basis: 'No owner-intended policy is supplied by this saved report. Intended policy needs H02/S14.' }
}

export function findingPriority(detail: AuditDetail, index: number): FindingPriority {
  const report = detail.report
  const finding = report.findings[index]
  const severity = severityInput(detail, index)
  const confidence = confidenceInput(report, index)
  const reach = reachInput(detail, finding, index)
  const policy = policyInput(report)
  const inputs = [severity, confidence, reach, policy]
  const describe = (input: PriorityInput) => input.state === 'known' ? (input.value ?? 'unknown') : input.state
  const rationale = `Priority basis ${priorityVersion}: technical severity ${describe(severity)}; evidence confidence ${describe(confidence)}; affected reach ${describe(reach)}; intended policy ${describe(policy)}. Business exposure, estimated effort and recommendation rationale are owner-entered planning fields, not provider evidence, and are not scored. Work status and attempts do not verify a fix. No predicted revenue or recovery amount is calculated.`
  return { version: priorityVersion, inputs, rationale }
}
