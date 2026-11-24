//! Receiver-owned saved-summary derivation regression tests.
//!
//! These tests are local and offline. They pin the committed source/summary
//! bytes, prove the canonical summary is reproducible, and check that the
//! batch verifier preserves the same coverage semantics as the single-rule
//! path. They do not open the receiver route or contact any live service.

use htp_s14_receiver::{
    Coverage, InspectionError, MAX_SAVED_SUMMARY_BYTES, SAVED_SUMMARY_VERSION,
    derive_saved_summary, finding_coverage, finding_coverage_batch,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(30)
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn manifest() -> Value {
    serde_json::from_slice(
        &fs::read(fixtures().join("s14-saved-summary-v1/manifest.json")).unwrap(),
    )
    .unwrap()
}

fn hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn batch_rule<'a>(
    batch: &'a htp_s14_receiver::BatchCoverage,
    rule: &str,
) -> &'a htp_s14_receiver::RuleCoverage {
    batch
        .rules
        .iter()
        .find(|candidate| candidate.rule == rule)
        .unwrap_or_else(|| panic!("missing rule {rule}"))
}

#[test]
fn committed_fixtures_are_reproducible_and_bounded() {
    let manifest = manifest();
    assert_eq!(manifest["format"], "s14-saved-summary-v1");
    assert_eq!(manifest["summary_version"], SAVED_SUMMARY_VERSION);
    let entries = manifest["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 7);
    for entry in entries {
        let case = entry["case"].as_str().unwrap();
        let source = fs::read(fixtures().join(entry["source_path"].as_str().unwrap())).unwrap();
        let expected = fs::read(fixtures().join(entry["summary_path"].as_str().unwrap())).unwrap();
        assert_eq!(
            source.len() as u64,
            entry["source_bytes"].as_u64().unwrap(),
            "{case} source bytes"
        );
        assert_eq!(
            hex(&source),
            entry["source_sha256"].as_str().unwrap(),
            "{case} source sha256"
        );
        assert_eq!(
            expected.len() as u64,
            entry["summary_bytes"].as_u64().unwrap(),
            "{case} summary bytes"
        );
        assert_eq!(
            hex(&expected),
            entry["summary_sha256"].as_str().unwrap(),
            "{case} summary sha256"
        );
        let saved = derive_saved_summary(&source, deadline()).unwrap();
        assert_eq!(saved.canonical, expected, "{case} canonical bytes");
        assert_eq!(
            saved.sha256,
            format!("sha256:{}", entry["summary_sha256"].as_str().unwrap()),
            "{case} digest"
        );
        assert_eq!(
            saved.source_sha256,
            format!("sha256:{}", entry["source_sha256"].as_str().unwrap()),
            "{case} source digest"
        );
        assert_eq!(
            saved.source_bytes,
            entry["source_bytes"].as_u64().unwrap(),
            "{case} source bytes"
        );
        assert!(saved.canonical.len() <= MAX_SAVED_SUMMARY_BYTES);
        let value: Value = serde_json::from_slice(&saved.canonical).unwrap();
        assert_eq!(value["summary_version"], SAVED_SUMMARY_VERSION);
        assert_eq!(value["schema_version"], 4);
        assert_eq!(value["wire_contract_version"], "s14-wire-1");
        assert!(value["evidence_contract_version"].is_null());
        assert_eq!(value["evidence_state"], "policy_versioned");
        assert_eq!(value["rule_coverage"].as_object().unwrap().len(), 88);
    }
}

#[test]
fn batch_matches_single_rule_and_preserves_coverage_semantics() {
    for case in [
        "complete-clean-h1",
        "complete-missing-h1",
        "partial-clean-h1",
        "partial-missing-h1",
    ] {
        let raw =
            fs::read(fixtures().join(format!("s14-finding-coverage-v1/{case}.json"))).unwrap();
        let batch = finding_coverage_batch(&raw, deadline()).unwrap();
        assert_eq!(batch.rules.len(), 88, "{case} catalogue size");
        for rule in [
            "missing_h1",
            "missing_description",
            "little_content",
            "deadend",
            "missing_language",
            "short_title",
        ] {
            let single = finding_coverage(&raw, rule, deadline()).unwrap();
            let batched = batch_rule(&batch, rule);
            assert_eq!(
                batched.reported_findings, single.reported_findings,
                "{case} {rule}"
            );
            assert_eq!(batched.coverage, single.coverage, "{case} {rule}");
        }
        assert_eq!(
            batch.audit,
            finding_coverage(&raw, "missing_h1", deadline())
                .unwrap()
                .audit
        );
    }
}

#[test]
fn complete_claims_are_verified_and_unverified_claims_stay_unknown() {
    let complete =
        fs::read(fixtures().join("s14-finding-coverage-v1/complete-clean-h1.json")).unwrap();
    let batch = finding_coverage_batch(&complete, deadline()).unwrap();
    assert_eq!(batch.audit, Coverage::CompleteVerified);
    assert!(
        batch
            .rules
            .iter()
            .all(|rule| rule.coverage == Coverage::CompleteVerified)
    );
    assert_eq!(batch_rule(&batch, "missing_h1").reported_findings, 0);

    let partial =
        fs::read(fixtures().join("s14-finding-coverage-v1/partial-clean-h1.json")).unwrap();
    let batch = finding_coverage_batch(&partial, deadline()).unwrap();
    assert_eq!(batch.audit, Coverage::UnknownPartial);
    assert_eq!(
        batch_rule(&batch, "missing_h1").coverage,
        Coverage::CompleteVerified
    );
    assert_eq!(
        batch_rule(&batch, "external_link").coverage,
        Coverage::UnknownPartial
    );

    let missing =
        fs::read(fixtures().join("s14-finding-coverage-v1/partial-missing-h1.json")).unwrap();
    let batch = finding_coverage_batch(&missing, deadline()).unwrap();
    assert_eq!(batch.audit, Coverage::UnknownPartial);
    assert_eq!(batch_rule(&batch, "missing_h1").reported_findings, 1);
    assert_eq!(
        batch_rule(&batch, "missing_h1").coverage,
        Coverage::UnknownPartial
    );
    assert!(
        batch
            .rules
            .iter()
            .all(|rule| rule.coverage == Coverage::UnknownPartial)
    );

    let no_extension = fs::read(fixtures().join("v4-candidate-complete.json")).unwrap();
    let batch = finding_coverage_batch(&no_extension, deadline()).unwrap();
    assert_eq!(batch.audit, Coverage::UnknownPartial);
    assert!(
        batch
            .rules
            .iter()
            .all(|rule| rule.coverage == Coverage::UnknownPartial)
    );
}

#[test]
fn batch_does_not_certify_an_incomplete_policy_row() {
    let mut report: Value = serde_json::from_slice(
        &fs::read(fixtures().join("s14-finding-coverage-v1/partial-clean-h1.json")).unwrap(),
    )
    .unwrap();
    report["finding_coverage"]["audit"] = Value::String("partial".to_owned());
    for check in report["finding_coverage"]["checks"].as_array_mut().unwrap() {
        check["status"] = Value::String("unknown".to_owned());
        if check["rule_id"] == "short_title" {
            check["status"] = Value::String("complete".to_owned());
        }
    }
    for row in report["policy_guidance"]["candidate"]["coverage"]
        .as_array_mut()
        .unwrap()
    {
        if row["rule_id"] == "short_title" {
            row["complete"] = Value::Bool(false);
        }
    }
    let raw = serde_json::to_vec(&report).unwrap();
    let batch = finding_coverage_batch(&raw, deadline()).unwrap();
    assert_eq!(batch.audit, Coverage::UnknownPartial);
    assert_eq!(
        batch_rule(&batch, "short_title").coverage,
        Coverage::UnknownPartial
    );
}

#[test]
fn summary_never_presents_an_unverified_claim_as_clean() {
    let partial =
        fs::read(fixtures().join("s14-finding-coverage-v1/partial-clean-h1.json")).unwrap();
    let saved = derive_saved_summary(&partial, deadline()).unwrap();
    let value: Value = serde_json::from_slice(&saved.canonical).unwrap();
    assert_eq!(value["audit_coverage"], "unknown_partial");
    assert_eq!(value["evaluation_coverage_complete"], false);
    assert_eq!(value["coverage_complete"], false);
    assert_eq!(
        value["rule_coverage"]["missing_h1"]["coverage"],
        "complete_verified"
    );
    assert_eq!(
        value["rule_coverage"]["external_link"]["coverage"],
        "unknown_partial"
    );

    let no_extension = fs::read(fixtures().join("v4-candidate-complete.json")).unwrap();
    let saved = derive_saved_summary(&no_extension, deadline()).unwrap();
    let value: Value = serde_json::from_slice(&saved.canonical).unwrap();
    assert_eq!(value["audit_coverage"], "unknown_partial");
    assert_eq!(value["evaluation_coverage_complete"], false);
    assert_eq!(value["coverage_complete"], false);
    assert_eq!(
        value["rule_coverage"]["missing_h1"]["coverage"],
        "unknown_partial"
    );
}

#[test]
fn unsupported_schema_is_rejected_before_derivation() {
    for schema in [1, 2, 3, 5] {
        let raw = serde_json::to_vec(&serde_json::json!({"schema_version": schema})).unwrap();
        assert_eq!(
            derive_saved_summary(&raw, deadline()).unwrap_err(),
            htp_s14_receiver::InspectionError::UnsupportedSchema
        );
    }
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_json(&object[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(array) => format!(
            "[{}]",
            array
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.to_string(),
    }
}

#[test]
fn summary_above_sixteen_kib_is_rejected_not_truncated() {
    let mut report: Value = serde_json::from_slice(
        &fs::read(fixtures().join("s14-finding-coverage-v1/complete-clean-h1.json")).unwrap(),
    )
    .unwrap();
    // Keep the report valid while making one bounded summary field large enough
    // to push the canonical summary over 16 KiB. The policy canonical JSON and
    // digest are recomputed so inspection still accepts the retained input.
    let long = "x".repeat(16_000);
    report["engine_version"] = Value::String(long.clone());
    let mut policy: Value = serde_json::from_str(
        report["policy_guidance"]["candidate"]["policy_canonical_json"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    policy["engine_version"] = Value::String(long);
    let policy_canonical = canonical_json(&policy);
    report["policy_guidance"]["candidate"]["policy_canonical_json"] =
        Value::String(policy_canonical.clone());
    let policy_digest = format!("sha256:{}", hex(policy_canonical.as_bytes()));
    report["policy_guidance"]["candidate"]["policy_digest"] = Value::String(policy_digest.clone());
    for record in report["policy_guidance"]["candidate"]["records"]
        .as_array_mut()
        .unwrap()
    {
        if record.get("policy_ref").is_some() {
            record["policy_ref"] = Value::String(policy_digest.clone());
        }
    }
    let raw = serde_json::to_vec(&report).unwrap();
    assert_eq!(
        derive_saved_summary(&raw, deadline()).unwrap_err(),
        htp_s14_receiver::InspectionError::SummaryTooLarge
    );
    assert_eq!(MAX_SAVED_SUMMARY_BYTES, 16_384);
}

#[test]
fn expired_budget_fails_closed_before_work() {
    // A deadline already in the past must stop both the summary derivation and
    // the batch verifier before any report-specific work is certified.
    let source =
        fs::read(fixtures().join("s14-finding-coverage-v1/complete-clean-h1.json")).unwrap();
    let expired = Instant::now() - Duration::from_secs(1);
    assert_eq!(
        derive_saved_summary(&source, expired).unwrap_err(),
        InspectionError::Deadline
    );
    assert_eq!(
        finding_coverage_batch(&source, expired).unwrap_err(),
        InspectionError::Deadline
    );
}

#[test]
fn batch_rejects_a_contradicted_complete_claim() {
    // A complete audit must fail closed when the retained per-rule multiset no
    // longer matches the independently reproduced expected population.
    let source =
        fs::read(fixtures().join("s14-finding-coverage-v1/complete-missing-h1.json")).unwrap();
    let mut report: Value = serde_json::from_slice(&source).unwrap();
    let findings = report["findings"].as_array_mut().unwrap();
    let position = findings
        .iter()
        .position(|finding| finding["rule"] == "missing_h1")
        .unwrap();
    findings.remove(position);
    let raw = serde_json::to_vec(&report).unwrap();
    assert_eq!(
        finding_coverage_batch(&raw, deadline()).unwrap_err(),
        InspectionError::SemanticMismatch
    );
    // The intact source still verifies, so the rejection is caused by the tamper.
    assert!(finding_coverage_batch(&source, deadline()).is_ok());
}
