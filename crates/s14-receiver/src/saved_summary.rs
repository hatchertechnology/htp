//! Receiver-owned, bounded schema-4 saved summary (version 5).
//!
//! The summary is derived only after the receiver's existing local checks have
//! accepted the retained report. It never treats an unverified or partial
//! coverage claim as clean. A complete rule/audit is reported only when the
//! batch verifier reproduced the expected finding population and its source
//! prerequisite. Missing or partial coverage remains `unknown_partial`.
//!
//! The canonical summary is compact UTF-8 JSON produced by the pinned Rust
//! `serde`/`serde_json` serializer for `SummaryV5`: struct fields are emitted in
//! declaration order and every map is a `BTreeMap`, so object keys are sorted
//! and the bytes are deterministic. This is not RFC 8785 JCS; reproduce the
//! digest with this exact serializer or the committed fixture bytes. The
//! summary SHA-256 and the retained-source SHA-256 are computed over their
//! exact bytes and reported as `sha256:<lowercase-hex>`. The source digest and
//! byte count are returned beside the summary digest; they are not part of the
//! emitted summary wire object. The output is rejected above 16 KiB. Schema 1/2
//! and other non-schema-4 reports are unsupported by this derivation; the
//! existing version-4 summary adapters remain in place for those schemas.
use crate::{Coverage, InspectionError as E};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    time::Instant,
};

/// Exact saved-summary version emitted for schema 4.
pub const SAVED_SUMMARY_VERSION: u32 = 5;
/// Maximum canonical summary bytes. The output is rejected, never truncated.
pub const MAX_SAVED_SUMMARY_BYTES: usize = 16_384;
const WIRE_CONTRACT_VERSION: &str = "s14-wire-1";
const EVIDENCE_STATE: &str = "policy_versioned";

/// A derived summary, its canonical representation, and the exact retained
/// source binding that produced it.
///
/// `sha256` is the digest of the canonical summary bytes. `source_sha256` and
/// `source_bytes` bind the summary to the retained report input so a stored
/// result can prove which bytes produced it. Both digest fields use the same
/// explicit `sha256:<lowercase-hex>` representation; the byte counts are exact
/// and neither is part of the emitted summary wire object.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedSummary {
    pub summary: Value,
    pub canonical: Vec<u8>,
    pub sha256: String,
    pub source_sha256: String,
    pub source_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
struct SummaryV5 {
    summary_version: u32,
    schema_version: u64,
    wire_contract_version: &'static str,
    evidence_contract_version: Option<u32>,
    evidence_state: &'static str,
    engine_version: String,
    ruleset_version: String,
    started_at: String,
    finished_at: String,
    outcome: String,
    stop_reason: String,
    crawl_coverage_complete: bool,
    evaluation_coverage_complete: bool,
    coverage_complete: bool,
    audit_coverage: &'static str,
    policy_digest: String,
    manifest_digest: String,
    scope_digest: String,
    comparison_key: String,
    pages: ObservationCounts,
    resources: ObservationCounts,
    findings: u64,
    severities: BTreeMap<String, u64>,
    rules: BTreeMap<String, u64>,
    record_counts: RecordCounts,
    omitted_records: u64,
    omitted_observations: u64,
    rule_coverage: BTreeMap<String, RuleCoverageSummary>,
}

#[derive(Debug, Clone, Default, Serialize)]
struct ObservationCounts {
    checked: u64,
    html: u64,
    images: u64,
    http_errors: u64,
    fetch_errors: u64,
    blocked: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
struct RecordCounts {
    observation: u64,
    advisory_triggered: u64,
    advisory_not_triggered: u64,
    violation: u64,
    no_violation: u64,
    not_applicable: u64,
    unknown: u64,
}

#[derive(Debug, Clone, Serialize)]
struct RuleCoverageSummary {
    coverage: &'static str,
    reported_findings: u64,
}

#[derive(Deserialize)]
struct FindingsOnly<'a> {
    #[serde(borrow)]
    findings: Vec<&'a serde_json::value::RawValue>,
}

#[derive(Deserialize)]
struct FindingSummary {
    rule: String,
    severity: String,
    url: String,
}

fn coverage_name(coverage: Coverage) -> &'static str {
    match coverage {
        Coverage::CompleteVerified => "complete_verified",
        Coverage::UnknownPartial => "unknown_partial",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn comparison_key(policy_digest: &str, manifest_digest: &str) -> String {
    let material = format!(
        "seosmith-comparison-v1\n{WIRE_CONTRACT_VERSION}\n{policy_digest}\n{manifest_digest}\n"
    );
    format!("sha256:{}", sha256_hex(material.as_bytes()))
}

fn html_content_type(content_type: &str) -> bool {
    matches!(
        content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "text/html" | "application/xhtml+xml" | "application/vnd.wap.xhtml+xml"
    )
}

fn observation_counts(pages: &[Value], resources: bool) -> ObservationCounts {
    let mut counts = ObservationCounts::default();
    for page in pages {
        if page["is_resource"].as_bool().unwrap_or(false) != resources {
            continue;
        }
        counts.checked += 1;
        let status = page["status"].as_u64();
        let content_type = page["content_type"].as_str().unwrap_or("");
        if status.is_some_and(|value| (200..300).contains(&value))
            && html_content_type(content_type)
        {
            counts.html += 1;
        }
        if content_type.to_ascii_lowercase().starts_with("image/") {
            counts.images += 1;
        }
        if status.is_some_and(|value| (400..600).contains(&value)) {
            counts.http_errors += 1;
        }
        if !page["error"].is_null() {
            counts.fetch_errors += 1;
        }
        if page["blocked_by_robots"].as_bool() == Some(true) {
            counts.blocked += 1;
        }
    }
    counts
}

fn navigation_excluded(page: &Value, relation: &Value) -> bool {
    if relation["kind"].as_str() != Some("navigation")
        || relation["resource"].as_bool() != Some(false)
        || !matches!(
            relation["state"].as_str(),
            Some("outside_scope" | "not_fetched")
        )
    {
        return false;
    }
    let robots = page["robots"].as_str().unwrap_or("").to_ascii_lowercase();
    let robots_excluded = robots
        .split(|character: char| character.is_whitespace() || character == ',' || character == ';')
        .any(|token| matches!(token, "nofollow" | "none"));
    let descriptor = relation["descriptor"]
        .as_str()
        .unwrap_or("")
        .to_ascii_lowercase();
    let descriptor_excluded = descriptor
        .split_whitespace()
        .any(|token| matches!(token, "nofollow" | "sponsored" | "ugc"));
    page["is_resource"].as_bool() == Some(true) || robots_excluded || descriptor_excluded
}

/// Recomputes the base crawl completeness independently from retained pages.
/// It does not trust the report's `coverage_complete` flag alone.
fn crawl_coverage_complete(projected: &Value, deadline: Instant) -> Result<bool, E> {
    if projected["coverage_complete"].as_bool() != Some(true) {
        return Ok(false);
    }
    let pages = projected["pages"].as_array().ok_or(E::Shape)?;
    let mut checked = HashSet::new();
    for page in pages {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        let status = page["status"].as_u64();
        if status.is_some_and(|value| (100..=599).contains(&value))
            && page["error"].is_null()
            && page["blocked_by_robots"].as_bool() != Some(true)
            && let Some(url) = page["url"].as_str()
        {
            checked.insert(url.to_owned());
        }
    }
    for page in pages {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        if page["extraction_truncated"].as_bool() == Some(true)
            || page["blocked_by_robots"].as_bool() == Some(true)
            || !page["error"].is_null()
            || !page["status"]
                .as_u64()
                .is_some_and(|value| (100..=599).contains(&value))
        {
            return Ok(false);
        }
        if let Some(flags) = page["flags"].as_array() {
            if flags.iter().any(|flag| {
                matches!(
                    flag.as_str(),
                    Some("extraction_limit" | "discovery_limit" | "legacy_checkpoint_metadata")
                )
            }) {
                return Ok(false);
            }
        } else if !page["flags"].is_null() {
            return Ok(false);
        }
        if let Some(relationships) = page["relationships"].as_array() {
            for relation in relationships {
                if navigation_excluded(page, relation) {
                    continue;
                }
                if relation["state"].as_str() != Some("checked") {
                    return Ok(false);
                }
                let Some(target) = relation["url"].as_str() else {
                    return Ok(false);
                };
                if !checked.contains(target) {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}

fn record_counts(projected: &Value, deadline: Instant) -> Result<(RecordCounts, u64, u64), E> {
    let rows = projected["policy_guidance"]["candidate"]["coverage"]
        .as_array()
        .ok_or(E::Shape)?;
    let mut counts = RecordCounts::default();
    let mut omitted_records = 0u64;
    let mut omitted_observations = 0u64;
    for row in rows {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        let omitted = row["omitted"].as_u64().ok_or(E::Shape)?;
        omitted_records += omitted;
        if row["category"].as_str() == Some("observation") {
            omitted_observations += omitted;
        }
        let Some(outcomes) = row["outcomes"].as_object() else {
            return Err(E::Shape);
        };
        for (outcome, count) in outcomes {
            let count = count.as_u64().ok_or(E::Shape)?;
            match outcome.as_str() {
                "observed" => counts.observation += count,
                "advisory_triggered" => counts.advisory_triggered += count,
                "advisory_not_triggered" => counts.advisory_not_triggered += count,
                "violation" => counts.violation += count,
                "no_violation" => counts.no_violation += count,
                "not_applicable" => counts.not_applicable += count,
                "unknown" => counts.unknown += count,
                _ => return Err(E::Shape),
            }
        }
    }
    Ok((counts, omitted_records, omitted_observations))
}

type FindingsCounts = (u64, BTreeMap<String, u64>, BTreeMap<String, u64>);

fn findings_summary(input: &[u8], deadline: Instant) -> Result<FindingsCounts, E> {
    let report: FindingsOnly<'_> = serde_json::from_slice(input).map_err(|_| E::Shape)?;
    let mut severities = BTreeMap::new();
    let mut rules = BTreeMap::new();
    for raw in &report.findings {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        let finding: FindingSummary = serde_json::from_str(raw.get()).map_err(|_| E::Shape)?;
        if !matches!(finding.severity.as_str(), "critical" | "alert" | "warning")
            || finding.rule.is_empty()
            || finding.url.is_empty()
        {
            return Err(E::Shape);
        }
        *severities.entry(finding.severity).or_insert(0) += 1;
        *rules.entry(finding.rule).or_insert(0) += 1;
    }
    Ok((report.findings.len() as u64, severities, rules))
}

/// Derives the bounded schema-4 saved summary from receiver-validated retained
/// inputs.
///
/// The report is first inspected and checked by the existing source-binding,
/// consistency, reconstructed-rule and batch coverage checks. A complete claim
/// is represented only after those checks and the batch population comparison
/// succeed. Partial or absent coverage remains `unknown_partial`.
///
/// # Errors
/// Rejects non-schema-4 input (`UnsupportedSchema`), malformed/unverified input
/// (the existing inspection/check errors), deadline expiry (`Deadline`), and a
/// canonical summary above 16 KiB (`SummaryTooLarge`).
pub fn derive_saved_summary(input: &[u8], deadline: Instant) -> Result<SavedSummary, E> {
    let schema = serde_json::from_slice::<Value>(input)
        .ok()
        .and_then(|value| value.get("schema_version").and_then(Value::as_u64));
    if schema != Some(4) {
        return Err(E::UnsupportedSchema);
    }
    crate::inspect(input, deadline)?;
    crate::check_source_bindings(input, deadline)?;
    crate::check_consistency(input, deadline)?;
    crate::check_reconstructed_rules(input, deadline)?;
    crate::check_compatibility_findings(input, deadline)?;
    let batch = crate::finding_coverage_batch(input, deadline)?;
    let projected = crate::projection::project(input)?;
    let crawl = crawl_coverage_complete(&projected, deadline)?;
    let evaluation = batch.audit == Coverage::CompleteVerified;
    let (record_counts, omitted_records, omitted_observations) =
        record_counts(&projected, deadline)?;
    let (findings, severities, rules) = findings_summary(input, deadline)?;
    let pages = projected["pages"].as_array().ok_or(E::Shape)?;
    let policy_digest = projected["policy_guidance"]["candidate"]["policy_digest"]
        .as_str()
        .ok_or(E::Shape)?
        .to_owned();
    let manifest_digest = projected["policy_guidance"]["candidate"]["manifest_digest"]
        .as_str()
        .ok_or(E::Shape)?
        .to_owned();
    let scope_digest = projected["policy_guidance"]["candidate"]["scope_digest"]
        .as_str()
        .ok_or(E::Shape)?
        .to_owned();
    let comparison_key = comparison_key(&policy_digest, &manifest_digest);
    let mut rule_coverage = BTreeMap::new();
    for rule in &batch.rules {
        rule_coverage.insert(
            rule.rule.clone(),
            RuleCoverageSummary {
                coverage: coverage_name(rule.coverage),
                reported_findings: rule.reported_findings as u64,
            },
        );
    }
    let summary = SummaryV5 {
        summary_version: SAVED_SUMMARY_VERSION,
        schema_version: projected["schema_version"].as_u64().ok_or(E::Shape)?,
        wire_contract_version: WIRE_CONTRACT_VERSION,
        evidence_contract_version: None,
        evidence_state: EVIDENCE_STATE,
        engine_version: projected["engine_version"]
            .as_str()
            .ok_or(E::Shape)?
            .to_owned(),
        ruleset_version: projected["ruleset_version"]
            .as_str()
            .ok_or(E::Shape)?
            .to_owned(),
        started_at: projected["started_at"].as_str().ok_or(E::Shape)?.to_owned(),
        finished_at: projected["finished_at"]
            .as_str()
            .ok_or(E::Shape)?
            .to_owned(),
        outcome: projected["outcome"].as_str().ok_or(E::Shape)?.to_owned(),
        stop_reason: projected["stop_reason"]
            .as_str()
            .ok_or(E::Shape)?
            .to_owned(),
        crawl_coverage_complete: crawl,
        evaluation_coverage_complete: evaluation,
        coverage_complete: crawl && evaluation,
        audit_coverage: coverage_name(batch.audit),
        policy_digest,
        manifest_digest,
        scope_digest,
        comparison_key,
        pages: observation_counts(pages, false),
        resources: observation_counts(pages, true),
        findings,
        severities,
        rules,
        record_counts,
        omitted_records,
        omitted_observations,
        rule_coverage,
    };
    let canonical = serde_json::to_vec(&summary).map_err(|_| E::Shape)?;
    if canonical.len() > MAX_SAVED_SUMMARY_BYTES {
        return Err(E::SummaryTooLarge);
    }
    let summary = serde_json::to_value(&summary).map_err(|_| E::Shape)?;
    let sha256 = format!("sha256:{}", sha256_hex(&canonical));
    let source_sha256 = format!("sha256:{}", sha256_hex(input));
    let source_bytes = u64::try_from(input.len()).map_err(|_| E::Shape)?;
    Ok(SavedSummary {
        summary,
        canonical,
        sha256,
        source_sha256,
        source_bytes,
    })
}
