use htp_s14_receiver::{
    Coverage, InspectionError, check_compatibility_findings, check_consistency,
    check_reconstructed_rules, check_scalar_advisories, check_source_bindings, finding_coverage,
    inspect,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

const V1: &str = "s14-finding-coverage-v1";

fn check_bytes(
    bytes: &[u8],
    rule: &str,
) -> Result<htp_s14_receiver::FindingCoverage, InspectionError> {
    finding_coverage(bytes, rule, Instant::now() + Duration::from_secs(30))
}
fn check(v: &Value, rule: &str) -> Result<htp_s14_receiver::FindingCoverage, InspectionError> {
    check_bytes(&serde_json::to_vec(v).unwrap(), rule)
}
fn fixture_bytes(name: &str) -> Vec<u8> {
    match name {
        "complete-missing-h1" => {
            include_bytes!("fixtures/s14-finding-coverage-v1/complete-missing-h1.json").to_vec()
        }
        "complete-clean-h1" => {
            include_bytes!("fixtures/s14-finding-coverage-v1/complete-clean-h1.json").to_vec()
        }
        "partial-missing-h1" => {
            include_bytes!("fixtures/s14-finding-coverage-v1/partial-missing-h1.json").to_vec()
        }
        "partial-clean-h1" => {
            include_bytes!("fixtures/s14-finding-coverage-v1/partial-clean-h1.json").to_vec()
        }
        _ => unreachable!(),
    }
}
fn fixture(name: &str) -> Value {
    serde_json::from_slice(&fixture_bytes(name)).unwrap()
}
fn historical() -> Value {
    serde_json::from_str(include_str!("fixtures/v4-candidate-complete.json")).unwrap()
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn remove_finding(report: &mut Value, rule: &str) {
    let findings = report["findings"].as_array_mut().unwrap();
    let position = findings.iter().position(|f| f["rule"] == rule).unwrap();
    findings.remove(position);
}
fn coverage_row_mut<'a>(report: &'a mut Value, category: &str, rule: &str) -> &'a mut Value {
    report["policy_guidance"]["candidate"]["coverage"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|r| r["category"] == category && r["rule_id"] == rule)
        .unwrap()
}

#[test]
fn producer_fixture_bytes_are_pinned() {
    for (name, sha) in [
        (
            "complete-missing-h1",
            "2443936d93da699595bdb135995e3d1d1503b96d973f5be4f3b82d9f243f4342",
        ),
        (
            "complete-clean-h1",
            "1f4b0889b2477397f129eaaa59d3d9c3451fe83bbd8c2ae50e039cf7f7fd87ff",
        ),
        (
            "partial-missing-h1",
            "d3c2ebd72e6632c5e9f654e7675a13b3a6850841e4f685d5e032dade1137200d",
        ),
        (
            "partial-clean-h1",
            "e95085661f1cbddc165e3acf47fb05a69e47bbe6c4be4dbffe480b385f15902e",
        ),
    ] {
        assert_eq!(sha256(&fixture_bytes(name)), sha, "{name}");
    }
    assert_eq!(
        sha256(include_bytes!(
            "fixtures/s14-finding-coverage-v1/catalogue-v1.json"
        )),
        "eaf832c1c0f087f46aec4d5fd62df35c43a52c2d773886912178a1ed12956ea8"
    );
    // Vendored producer catalogue drives the fixture extension rule ids.
    let catalogue: Value = serde_json::from_slice(include_bytes!(
        "fixtures/s14-finding-coverage-v1/catalogue-v1.json"
    ))
    .unwrap();
    let rules = catalogue["rules"].as_array().unwrap();
    assert_eq!(rules.len(), 88);
    assert!(rules.windows(2).all(|w| w[0].as_str() < w[1].as_str()));
    for name in [
        "complete-missing-h1",
        "complete-clean-h1",
        "partial-missing-h1",
        "partial-clean-h1",
    ] {
        let report = fixture(name);
        let checks = report["finding_coverage"]["checks"].as_array().unwrap();
        assert_eq!(checks.len(), rules.len(), "{name}");
        for (check, rule) in checks.iter().zip(rules) {
            assert_eq!(check["rule_id"], *rule, "{name}");
        }
    }
}

#[test]
fn complete_audit_with_observed_finding_is_verified() {
    let bytes = fixture_bytes("complete-missing-h1");
    let result = check_bytes(&bytes, "missing_h1").unwrap();
    assert_eq!(result.coverage, Coverage::CompleteVerified);
    assert_eq!(result.audit, Coverage::CompleteVerified);
    assert_eq!(result.reported_findings, 1);
    // A complete rule with an empty expected population is verified clean.
    let clean = check_bytes(&bytes, "missing_title").unwrap();
    assert_eq!(clean.coverage, Coverage::CompleteVerified);
    assert_eq!(clean.reported_findings, 0);
}

#[test]
fn complete_audit_clean_for_h1_is_verified_without_global_clean() {
    let bytes = fixture_bytes("complete-clean-h1");
    let result = check_bytes(&bytes, "missing_h1").unwrap();
    assert_eq!(result.coverage, Coverage::CompleteVerified);
    assert_eq!(result.audit, Coverage::CompleteVerified);
    assert_eq!(result.reported_findings, 0);
    // The audit is complete, not clean: other expected findings remain.
    let report = fixture("complete-clean-h1");
    assert!(
        report["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["rule"] == "little_content")
    );
}

#[test]
fn partial_audit_keeps_findings_visible_and_absence_unknown() {
    let bytes = fixture_bytes("partial-missing-h1");
    let result = check_bytes(&bytes, "missing_h1").unwrap();
    assert_eq!(result.coverage, Coverage::UnknownPartial);
    assert_eq!(result.audit, Coverage::UnknownPartial);
    assert_eq!(result.reported_findings, 1);
    let clean = check_bytes(&bytes, "invalid_language").unwrap();
    assert_eq!(clean.coverage, Coverage::UnknownPartial);
    assert_eq!(clean.reported_findings, 0);
}

#[test]
fn per_check_complete_survives_unrelated_partial_edges() {
    let bytes = fixture_bytes("partial-clean-h1");
    let result = check_bytes(&bytes, "missing_h1").unwrap();
    assert_eq!(result.coverage, Coverage::CompleteVerified);
    assert_eq!(result.audit, Coverage::UnknownPartial);
    assert_eq!(result.reported_findings, 0);
    // An edge-dependent rule stays unknown because the edge is unobserved.
    let edge = check_bytes(&bytes, "external_link_broken").unwrap();
    assert_eq!(edge.coverage, Coverage::UnknownPartial);
}

#[test]
fn contradicted_complete_claims_fail_closed() {
    // Missing expected finding.
    let mut missing = fixture("complete-missing-h1");
    remove_finding(&mut missing, "missing_h1");
    assert_eq!(
        check(&missing, "missing_h1").unwrap_err(),
        InspectionError::SemanticMismatch
    );
    // Extra finding for a rule whose expected population is empty.
    let mut extra = fixture("complete-missing-h1");
    let mut finding = extra["findings"][0].clone();
    finding["rule"] = json!("missing_title");
    finding["key"] = json!("0000000000000000000000000000000000000000000000000000000000000000");
    extra["findings"].as_array_mut().unwrap().push(finding);
    assert_eq!(
        check(&extra, "missing_h1").unwrap_err(),
        InspectionError::SemanticMismatch
    );
    // Duplicated finding changes multiplicity.
    let mut duplicate = fixture("complete-missing-h1");
    let finding = duplicate["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["rule"] == "missing_h1")
        .unwrap()
        .clone();
    duplicate["findings"].as_array_mut().unwrap().push(finding);
    assert_eq!(
        check(&duplicate, "missing_h1").unwrap_err(),
        InspectionError::SemanticMismatch
    );
    for field in ["key", "severity", "evidence"] {
        let mut altered = fixture("complete-missing-h1");
        let index = altered["findings"]
            .as_array()
            .unwrap()
            .iter()
            .position(|f| f["rule"] == "missing_h1")
            .unwrap();
        altered["findings"][index][field] = json!("changed value");
        assert_eq!(
            check(&altered, "missing_h1").unwrap_err(),
            InspectionError::SemanticMismatch,
            "{field}"
        );
    }
    let mut detail = fixture("complete-missing-h1");
    let index = detail["findings"]
        .as_array()
        .unwrap()
        .iter()
        .position(|f| f["rule"] == "missing_h1")
        .unwrap();
    detail["findings"][index]["details"]["observation_count"] = json!(2);
    assert_eq!(
        check(&detail, "missing_h1").unwrap_err(),
        InspectionError::SemanticMismatch
    );
}

#[test]
fn crawl_incompleteness_downgrades_global_but_not_local_claims() {
    // Aligned with the producer's item-local adequacy: a local rule's population
    // is verifiable over retained pages even when the crawl itself is partial.
    // Global absence stays unknown in every case.
    for (field, value) in [
        ("coverage_complete", json!(false)),
        ("outcome", json!("partial")),
        ("stop_reason", json!("page_limit")),
    ] {
        let mut report = fixture("complete-missing-h1");
        report[field] = value;
        let result = check(&report, "missing_h1").unwrap();
        assert_eq!(result.coverage, Coverage::CompleteVerified, "{field}");
        assert_eq!(result.audit, Coverage::UnknownPartial, "{field}");
        assert_eq!(result.reported_findings, 1, "{field}");
        // A graph check cannot be certified on an incomplete crawl.
        let graph = check(&report, "external_link_broken").unwrap();
        assert_eq!(graph.coverage, Coverage::UnknownPartial, "{field}");
        assert_eq!(graph.audit, Coverage::UnknownPartial, "{field}");
    }
    for (field, value) in [
        ("extraction_truncated", json!(true)),
        ("status", json!(null)),
        ("status", json!(404)),
        ("blocked_by_robots", json!(true)),
        ("error", json!("unavailable")),
        ("content_type", json!("application/pdf")),
        ("is_resource", json!(true)),
    ] {
        let mut report = fixture("complete-missing-h1");
        report["pages"][0][field] = value.clone();
        let result = check(&report, "missing_h1").unwrap();
        assert_eq!(result.coverage, Coverage::UnknownPartial, "{field}:{value}");
        assert_eq!(result.audit, Coverage::UnknownPartial, "{field}:{value}");
    }
}

#[test]
fn unobserved_external_target_blocks_graph_complete_claims() {
    // partial-clean-h1 is an ordinary producer partial with one unobserved
    // external edge. Promoting an edge-dependent check to complete must not
    // certify it, while the local heading check remains independently verified.
    let mut report = fixture("partial-clean-h1");
    let checks = report["finding_coverage"]["checks"].as_array_mut().unwrap();
    let index = checks
        .iter()
        .position(|c| c["rule_id"] == "external_link_broken")
        .unwrap();
    checks[index]["status"] = json!("complete");
    let edge = check(&report, "external_link_broken").unwrap();
    assert_eq!(edge.coverage, Coverage::UnknownPartial);
    assert_eq!(edge.audit, Coverage::UnknownPartial);
    let local = check(&report, "missing_h1").unwrap();
    assert_eq!(local.coverage, Coverage::CompleteVerified);
    assert_eq!(local.audit, Coverage::UnknownPartial);
    // A global complete claim over the same unobserved target stays unknown.
    let mut global = report.clone();
    global["finding_coverage"]["audit"] = json!("complete");
    for check in global["finding_coverage"]["checks"].as_array_mut().unwrap() {
        check["status"] = json!("complete");
    }
    let result = check(&global, "missing_h1").unwrap();
    assert_eq!(result.coverage, Coverage::CompleteVerified);
    assert_eq!(result.audit, Coverage::UnknownPartial);
}

#[test]
fn historical_absence_stays_unknown_but_findings_visible() {
    let report = historical();
    let reported = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["rule"] == "missing_h1")
        .count();
    let result = check(&report, "missing_h1").unwrap();
    assert_eq!(result.coverage, Coverage::UnknownPartial);
    assert_eq!(result.audit, Coverage::UnknownPartial);
    assert_eq!(result.reported_findings, reported);
    assert!(reported > 0);
}

#[test]
fn null_extension_is_rejected() {
    let mut report = historical();
    report["finding_coverage"] = json!(null);
    assert_eq!(
        check(&report, "missing_h1").unwrap_err(),
        InspectionError::Shape
    );
}

#[test]
fn complete_audit_must_cover_the_full_catalogue() {
    let mut report = historical();
    report["finding_coverage"] = json!({"version":1,"audit":"complete","checks":[{"rule_id":"missing_h1","status":"complete"}]});
    assert_eq!(
        check(&report, "missing_h1").unwrap_err(),
        InspectionError::Shape
    );
    report["finding_coverage"] = json!({"version":1,"audit":"complete","checks":[]});
    assert_eq!(
        check(&report, "missing_h1").unwrap_err(),
        InspectionError::Shape
    );
}

#[test]
fn malformed_extension_members_are_rejected() {
    let mut cases = Vec::new();
    let mut r = historical();
    r["finding_coverage"] = json!({"version":1,"audit":"partial","checks":[
        {"rule_id":"missing_language","status":"unknown"},
        {"rule_id":"missing_h1","status":"unknown"}]});
    cases.push(r); // unsorted
    let mut r = historical();
    r["finding_coverage"] = json!({"version":1,"audit":"partial","checks":[
        {"rule_id":"missing_h1","status":"unknown"},
        {"rule_id":"missing_h1","status":"complete"}]});
    cases.push(r); // duplicate
    let mut r = historical();
    r["finding_coverage"] = json!({"version":1,"audit":"partial","checks":[
        {"rule_id":"not_a_rule","status":"unknown"}]});
    cases.push(r); // unknown id
    let mut r = historical();
    r["finding_coverage"] = json!({"version":1,"audit":"partial","checks":[
        {"rule_id":"missing_h1","status":"clean"}]});
    cases.push(r); // invalid status
    let mut r = historical();
    r["finding_coverage"] = json!({"version":1,"audit":"complete","checks":[
        {"rule_id":"missing_h1","status":"unknown"}]});
    cases.push(r); // complete audit with unknown
    let mut r = historical();
    r["finding_coverage"] = json!({"version":1,"audit":"partial","checks":[
        {"rule_id":"missing_h1","status":"unknown","extra":true}]});
    cases.push(r); // extra member
    let mut r = historical();
    r["finding_coverage"] = json!({"version":1,"audit":"partial","checks":[
        {"rule_id":"missing_h1","status":"unknown"}],"extra":true});
    cases.push(r); // extra extension member
    for report in cases {
        assert_eq!(
            check(&report, "missing_h1").unwrap_err(),
            InspectionError::Shape
        );
    }
}

#[test]
fn unsupported_version_is_treated_as_absent() {
    let mut report = historical();
    report["finding_coverage"] = json!({"version":2,"audit":"complete","checks":[]});
    let result = check(&report, "missing_h1").unwrap();
    assert_eq!(result.coverage, Coverage::UnknownPartial);
    assert_eq!(result.audit, Coverage::UnknownPartial);
}

// Keep the vendored directory name referenced so it is obvious where the
// producer reconciliation fixtures live.
#[test]
fn vendored_producer_directory_is_documented() {
    assert_eq!(V1, "s14-finding-coverage-v1");
}

#[test]
fn producer_fixtures_pass_all_existing_receiver_checks() {
    for name in [
        "complete-missing-h1",
        "complete-clean-h1",
        "partial-missing-h1",
        "partial-clean-h1",
    ] {
        let bytes = fixture_bytes(name);
        let deadline = || Instant::now() + Duration::from_secs(30);
        assert!(inspect(&bytes, deadline()).is_ok(), "{name} inspect");
        assert!(
            check_consistency(&bytes, deadline()).is_ok(),
            "{name} consistency"
        );
        assert!(
            check_scalar_advisories(&bytes, deadline()).is_ok(),
            "{name} advisories"
        );
        assert!(
            check_reconstructed_rules(&bytes, deadline()).is_ok(),
            "{name} reconstructed"
        );
        assert!(
            check_source_bindings(&bytes, deadline()).is_ok(),
            "{name} bindings"
        );
        assert!(
            check_compatibility_findings(&bytes, deadline()).is_ok(),
            "{name} compatibility"
        );
        assert!(
            finding_coverage(&bytes, "missing_h1", deadline()).is_ok(),
            "{name} finding_coverage"
        );
    }
}

#[test]
fn policy_rule_claim_uses_reconstructed_coverage_rows() {
    // A normal generated policy row verifies for its own rule.
    let bytes = fixture_bytes("complete-missing-h1");
    let verified = check_bytes(&bytes, "short_title").unwrap();
    assert_eq!(verified.coverage, Coverage::CompleteVerified);
    assert_eq!(verified.reported_findings, 1);

    // The supplied row labels/counts are not trusted: keeping
    // `complete:true`/`omitted:0` but changing a retained count or outcome
    // distribution is caught by independent reconstruction and fails closed.
    for (field, value) in [
        ("emitted", json!(0)),
        ("outcomes", json!({"advisory_not_triggered": 1})),
        ("eligibility_counts", json!({"ineligible": 1})),
    ] {
        let mut report = fixture("complete-missing-h1");
        coverage_row_mut(&mut report, "advisory", "short_title")[field] = value;
        assert_eq!(
            check(&report, "short_title").unwrap_err(),
            InspectionError::SemanticMismatch,
            "{field}"
        );
    }
}

#[test]
fn missing_supplied_policy_row_cannot_pass_vacuously() {
    // Rename the `short_title` row so the 13-row array has no row for the
    // queried policy rule. `check_adequate` would pass vacuously; the pinned
    // policy catalogue forces the reconstruction, which rejects the tamper.
    let mut report = fixture("complete-missing-h1");
    coverage_row_mut(&mut report, "advisory", "short_title")["rule_id"] = json!("long_title");
    assert_eq!(
        check(&report, "short_title").unwrap_err(),
        InspectionError::SemanticMismatch
    );
    // The global claim is blocked by the same row reconstruction.
    assert_eq!(
        check(&report, "missing_h1").unwrap_err(),
        InspectionError::SemanticMismatch
    );
}

#[test]
fn missing_or_malformed_omitted_is_not_zero() {
    // A missing `omitted` member is never treated as zero.
    let mut missing = fixture("complete-missing-h1");
    coverage_row_mut(&mut missing, "advisory", "short_title")
        .as_object_mut()
        .unwrap()
        .remove("omitted");
    assert_eq!(
        check(&missing, "short_title").unwrap().coverage,
        Coverage::UnknownPartial
    );
    // Non-numeric, positive and negative counts are all not a verified zero.
    for value in [json!("0"), json!(1), json!(-1)] {
        let mut report = fixture("complete-missing-h1");
        coverage_row_mut(&mut report, "advisory", "short_title")["omitted"] = value;
        assert_eq!(
            check(&report, "short_title").unwrap().coverage,
            Coverage::UnknownPartial
        );
    }
}

#[test]
fn missing_coverage_array_is_shape() {
    let mut report = fixture("complete-missing-h1");
    report["policy_guidance"]["candidate"]
        .as_object_mut()
        .unwrap()
        .remove("coverage");
    assert_eq!(
        check(&report, "short_title").unwrap_err(),
        InspectionError::Shape
    );
}

#[test]
fn incomplete_later_policy_row_keeps_rule_unknown() {
    // `noindex` carries an observation row and a policy-violation row. An
    // omission in the later row makes the rule unknown even when the first row
    // is complete, matching the producer's per-row accounting.
    let mut report = fixture("complete-missing-h1");
    let row = coverage_row_mut(&mut report, "policy_violation", "noindex");
    row["complete"] = json!(false);
    row["omitted"] = json!(1);
    let result = check(&report, "noindex").unwrap();
    assert_eq!(result.coverage, Coverage::UnknownPartial);
    assert_eq!(result.audit, Coverage::UnknownPartial);
}

#[test]
fn valid_partial_result_still_verifies_a_policy_rule() {
    // A valid generated partial report keeps a verified item-local policy row
    // while the global audit stays unknown.
    let bytes = fixture_bytes("partial-clean-h1");
    let result = check_bytes(&bytes, "noindex").unwrap();
    assert_eq!(result.coverage, Coverage::CompleteVerified);
    assert_eq!(result.audit, Coverage::UnknownPartial);
    assert_eq!(result.reported_findings, 0);
}
