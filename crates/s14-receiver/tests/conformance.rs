//! Offline conformance regressions for the retained successor S14 bundle.
//!
//! These tests read local bytes only. The checked-in URL and coverage vectors
//! run in the ordinary suite. The external 61-file successor bundle is an
//! ignored, opt-in test: it requires `S14_SUCCESSOR_CONTRACTS` and must be
//! invoked deliberately with `--ignored`, so a missing external tree cannot
//! silently pass as if it had been checked.

use htp_s14_receiver::conformance;
use htp_s14_receiver::{
    Coverage,
    conformance::{
        CATALOGUE_SHA256, COVERAGE_MANIFEST_SHA256, URL_CASE_COUNT, URL_CORPUS_SHA256,
        coverage_label, verify_coverage_positives, verify_successor_contracts, verify_url_corpus,
    },
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn coverage<'a>(
    evidence: &'a [htp_s14_receiver::conformance::CoverageEvidence],
    case: &str,
) -> &'a htp_s14_receiver::conformance::CoverageEvidence {
    evidence
        .iter()
        .find(|entry| entry.case == case)
        .unwrap_or_else(|| panic!("missing coverage case {case}"))
}

#[test]
fn url_corpus_preserves_historical_labels_and_matches_receiver_decisions() {
    let bytes = fs::read(fixtures().join("url-cases-r2.json")).unwrap();
    let corpus = verify_url_corpus(&bytes).unwrap();
    assert_eq!(corpus.version, "s14-url-candidate-1");
    assert_eq!(corpus.revision, 2);
    assert_eq!(corpus.seed, "https://example.com/");
    assert_eq!(corpus.cases.len(), URL_CASE_COUNT);
    let mut labels = BTreeMap::new();
    for case in &corpus.cases {
        *labels.entry(case.label.as_str()).or_insert(0usize) += 1;
        match case.label.as_str() {
            "in_scope" => assert_eq!(case.decision.as_str(), "in_scope"),
            "out_of_scope" => assert_eq!(case.decision.as_str(), "out_of_scope"),
            "reject" | "reject_noncanonical" => assert_eq!(case.decision.as_str(), "reject"),
            other => panic!("unexpected historical label {other}"),
        }
    }
    assert_eq!(labels.get("in_scope"), Some(&6));
    assert_eq!(labels.get("out_of_scope"), Some(&9));
    assert_eq!(labels.get("reject"), Some(&15));
    assert_eq!(labels.get("reject_noncanonical"), Some(&12));
}

#[test]
fn checked_in_conformance_fixtures_are_byte_pinned() {
    let url = fs::read(fixtures().join("url-cases-r2.json")).unwrap();
    assert_eq!(sha256(&url), URL_CORPUS_SHA256);
    let coverage_manifest =
        fs::read(fixtures().join("s14-finding-coverage-v1/manifest.json")).unwrap();
    assert_eq!(sha256(&coverage_manifest), COVERAGE_MANIFEST_SHA256);
    let catalogue = fs::read(fixtures().join("s14-finding-coverage-v1/catalogue-v1.json")).unwrap();
    assert_eq!(sha256(&catalogue), CATALOGUE_SHA256);
}

#[test]
fn coverage_positives_match_every_producer_rule_and_preserve_partial_unknown() {
    let evidence = verify_coverage_positives(
        &fixtures().join("s14-finding-coverage-v1"),
        Duration::from_secs(30),
    )
    .unwrap();
    assert_eq!(evidence.len(), 4);
    assert_eq!(
        evidence
            .iter()
            .map(|case| case.case.as_str())
            .collect::<Vec<_>>(),
        [
            "complete-missing-h1.json",
            "complete-clean-h1.json",
            "partial-missing-h1.json",
            "partial-clean-h1.json",
        ]
    );

    let complete_missing = coverage(&evidence, "complete-missing-h1.json");
    assert_eq!(complete_missing.historical_audit, "complete");
    assert_eq!(complete_missing.audit, Coverage::CompleteVerified);
    assert_eq!(complete_missing.complete, 88);
    assert_eq!(complete_missing.unknown, 0);
    assert_eq!(complete_missing.missing_h1_findings, 1);
    assert_eq!(
        complete_missing.missing_h1_coverage,
        Coverage::CompleteVerified
    );
    assert_eq!(
        complete_missing.reported_rules,
        [
            "deadend",
            "little_content",
            "missing_description",
            "missing_h1",
            "missing_language",
            "short_title"
        ]
    );

    let complete_clean = coverage(&evidence, "complete-clean-h1.json");
    assert_eq!(complete_clean.audit, Coverage::CompleteVerified);
    assert_eq!(complete_clean.complete, 88);
    assert_eq!(complete_clean.missing_h1_findings, 0);
    assert_eq!(
        complete_clean.missing_h1_coverage,
        Coverage::CompleteVerified
    );

    let partial_missing = coverage(&evidence, "partial-missing-h1.json");
    assert_eq!(partial_missing.historical_audit, "partial");
    assert_eq!(partial_missing.audit, Coverage::UnknownPartial);
    assert_eq!(partial_missing.complete, 0);
    assert_eq!(partial_missing.unknown, 88);
    assert_eq!(partial_missing.missing_h1_findings, 1);
    assert_eq!(
        partial_missing.missing_h1_coverage,
        Coverage::UnknownPartial
    );

    let partial_clean = coverage(&evidence, "partial-clean-h1.json");
    assert_eq!(partial_clean.historical_audit, "partial");
    assert_eq!(partial_clean.audit, Coverage::UnknownPartial);
    assert_eq!(partial_clean.complete, 63);
    assert_eq!(partial_clean.unknown, 25);
    assert_eq!(partial_clean.missing_h1_findings, 0);
    assert_eq!(
        partial_clean.missing_h1_coverage,
        Coverage::CompleteVerified
    );
    assert_eq!(
        partial_clean.reported_rules,
        [
            "little_content",
            "missing_description",
            "missing_language",
            "short_title"
        ]
    );
    assert_eq!(coverage_label(partial_clean.audit), "unknown");
    assert_eq!(
        coverage_label(partial_clean.missing_h1_coverage),
        "complete"
    );
}

#[test]
#[ignore = "external fixture tree; set S14_SUCCESSOR_CONTRACTS and run with --ignored"]
fn external_successor_bundle_is_checked_only_when_explicitly_invoked() {
    let contracts = env::var_os("S14_SUCCESSOR_CONTRACTS")
        .map(PathBuf::from)
        .expect("S14_SUCCESSOR_CONTRACTS must point at producer fixtures/contracts");
    let evidence = verify_successor_contracts(&contracts, Duration::from_secs(30)).unwrap();
    assert_eq!(evidence.files.len(), 61);
    assert_eq!(evidence.label_count("accept"), 27); // historical labels
    assert_eq!(evidence.label_count("reference"), 13);
    assert_eq!(evidence.label_count("reject"), 20);
    assert_eq!(evidence.label_count("reject_url_profile_idn"), 1);
    assert_eq!(evidence.accepted_reports_checked, 10);
    assert_eq!(evidence.url_corpus.cases.len(), 42);
    assert_eq!(evidence.coverage.len(), 4);
    assert_eq!(
        evidence.files.iter().filter(|file| file.checked).count(),
        10
    );
    // Exactly the 17 dropped accepts are the unchecked `accept` files, and each
    // was verified to reject at population/semantic_mismatch while checking.
    let mut dropped: Vec<&str> = evidence
        .files
        .iter()
        .filter(|file| file.historical_label == "accept" && !file.checked)
        .map(|file| file.path.as_str())
        .collect();
    dropped.sort_unstable();
    assert_eq!(dropped, conformance::DROPPED_ACCEPTS);
    for file in &evidence.files {
        assert_eq!(
            file.checked,
            file.historical_label == "accept"
                && !conformance::DROPPED_ACCEPTS.contains(&file.path.as_str()),
            "{}",
            file.path
        );
    }
}

/// H1 amends the frozen #88 accept count: 17 of the 27 historical positives
/// are rejected by full-population admission and are dropped, leaving 10.
#[test]
fn successor_accept_count_is_amended_to_the_admitted_ten() {
    assert_eq!(conformance::HISTORICAL_ACCEPT_COUNT, 27);
    assert_eq!(conformance::ACCEPT_COUNT, 10);
    assert_eq!(conformance::DROPPED_ACCEPTS.len(), 17);
    let mut sorted = conformance::DROPPED_ACCEPTS;
    sorted.sort_unstable();
    assert_eq!(sorted, conformance::DROPPED_ACCEPTS, "kept sorted");
    assert!(sorted.windows(2).all(|w| w[0] != w[1]), "no duplicates");
    // The 10 survivors are exactly the S2 historical positives under
    // tests/fixtures/s14-schema4-historical/s14-wire-1-candidate.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/s14-schema4-historical/s14-wire-1-candidate");
    let mut kept = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        if name.starts_with("v4-candidate-") {
            kept += 1;
            assert!(
                !conformance::DROPPED_ACCEPTS.contains(&name.as_str()),
                "{name}"
            );
        }
    }
    assert_eq!(kept, conformance::ACCEPT_COUNT);
}
