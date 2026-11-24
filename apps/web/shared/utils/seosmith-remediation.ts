import type { AuditEvaluation, AuditReport } from '../types/seosmith'

/** Only the unique explicit failed evaluation for this exact saved finding is attributed. */
export function findingEvaluation(report: AuditReport, index: number): AuditEvaluation | undefined {
  const finding = report.findings[index]
  if (!finding) return undefined
  if ((report.evidence_contract?.version != null && report.evidence_contract.version !== 1) || !Array.isArray(report.evidence_contract?.evaluations)) return undefined
  const matches = report.evidence_contract.evaluations.filter(item =>
    item.finding_key === finding.key && item.source_locator === `/findings/${index}` && item.outcome === 'fail') ?? []
  return matches.length === 1 ? matches[0] : undefined
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

function severityInput(finding: AuditReport['findings'][number] | undefined, index: number): PriorityInput {
  if (!finding) return { key: 'severity', label: 'Technical severity', state: 'unknown', value: null, basis: `No saved finding exists at /findings/${index}.` }
  return { key: 'severity', label: 'Technical severity', state: 'known', value: finding.severity, basis: `Technical severity recorded by the producer for rule ${finding.rule}.` }
}

function confidenceInput(evaluation: AuditEvaluation | undefined, index: number): PriorityInput {
  if (!evaluation) return { key: 'confidence', label: 'Evidence confidence', state: 'unknown', value: null, basis: `No unique explicit failed evaluation points to saved finding /findings/${index}; legacy or ambiguous evidence.` }
  const basis = `Unique explicit failed ${evaluation.rule} evaluation (${evaluation.rule_version}, validator ${evaluation.validator_version}) at ${evaluation.source_locator}.`
  if (evaluation.confidence !== 'unknown') return { key: 'confidence', label: 'Evidence confidence', state: 'known', value: evaluation.confidence, basis }
  return { key: 'confidence', label: 'Evidence confidence', state: 'unknown', value: null, basis: `The unique explicit failed ${evaluation.rule} evaluation records confidence as unknown (${evaluation.rule_version}, validator ${evaluation.validator_version}).` }
}

function reachInput(report: AuditReport, finding: AuditReport['findings'][number] | undefined, index: number): PriorityInput {
  if (!finding) return { key: 'reach', label: 'Affected reach', state: 'unknown', value: null, basis: `No saved finding exists at /findings/${index}.` }
  const observed = new Set(report.findings.filter(item => item.rule === finding.rule).map(item => item.url)).size
  const contract = report.evidence_contract
  // A saved finding set establishes reach only when the run reports complete
  // coverage and any versioned evaluation coverage is explicitly complete,
  // untruncated and accounted for.
  const complete = report.coverage_complete === true
    && (!contract || (contract.version === 1 && contract.evaluation_coverage_complete === true && contract.truncated === false))
  if (complete) return { key: 'reach', label: 'Affected reach', state: 'known', value: String(observed), basis: `${observed} distinct saved URL(s) share rule ${finding.rule}, and the run reports complete coverage.` }
  return { key: 'reach', label: 'Affected reach', state: 'unknown', value: null, basis: `Coverage or evaluation coverage is incomplete; ${observed} saved URL(s) share rule ${finding.rule}, which is a lower bound only. Site-wide reach is unknown.` }
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

export function findingPriority(report: AuditReport, index: number): FindingPriority {
  const finding = report.findings[index]
  const severity = severityInput(finding, index)
  const confidence = confidenceInput(findingEvaluation(report, index), index)
  const reach = reachInput(report, finding, index)
  const policy = policyInput(report)
  const inputs = [severity, confidence, reach, policy]
  const describe = (input: PriorityInput) => input.state === 'known' ? (input.value ?? 'unknown') : input.state
  const rationale = `Priority basis ${priorityVersion}: technical severity ${describe(severity)}; evidence confidence ${describe(confidence)}; affected reach ${describe(reach)}; intended policy ${describe(policy)}. Business exposure, estimated effort and recommendation rationale are owner-entered planning fields, not provider evidence, and are not scored. Work status and attempts do not verify a fix. No predicted revenue or recovery amount is calculated.`
  return { version: priorityVersion, inputs, rationale }
}
