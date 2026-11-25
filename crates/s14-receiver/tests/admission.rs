//! Admission (`admit`) tests: full findings equality, evidence exclusion and
//! the validator revision. Offline. Fixtures are the committed producer pairs;
//! H1-final adds the S2 schema-4 corpus.
use htp_s14_receiver::{
    AdmissionStage, InspectionError, VALIDATOR_REVISION, admit, derive_saved_summary,
};
use serde_json::{Value, json};
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
fn load(name: &str) -> Value {
    serde_json::from_slice(&fs::read(fixtures().join(name)).unwrap()).unwrap()
}
fn bytes(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}
const POSITIVES: &[&str] = &[
    "s14-finding-coverage-v1/complete-clean-h1.json",
    "s14-finding-coverage-v1/complete-missing-h1.json",
    "s14-finding-coverage-v1/partial-clean-h1.json",
    "s14-finding-coverage-v1/partial-missing-h1.json",
    "v4-candidate-complete.json",
    "v4-candidate-intent.json",
    "v4-candidate-partial.json",
];
const MISSING_H1: &str = "s14-finding-coverage-v1/complete-missing-h1.json";

#[test]
fn positives_admit_and_the_summary_matches_the_derivation() {
    for name in POSITIVES {
        let raw = fs::read(fixtures().join(name)).unwrap();
        let admitted = admit(&raw, deadline()).unwrap_or_else(|e| panic!("{name}: {e}"));
        let derived = derive_saved_summary(&raw, deadline()).unwrap();
        assert_eq!(admitted.summary.canonical, derived.canonical, "{name}");
        assert_eq!(admitted.validator_revision, VALIDATOR_REVISION);
    }
}

fn assert_population_reject(report: &Value, label: &str) {
    let err = admit(&bytes(report), deadline()).expect_err(label);
    assert_eq!(
        err.error,
        InspectionError::SemanticMismatch,
        "{label}: {err}"
    );
}

#[test]
fn mutated_populations_reject() {
    let base = load(MISSING_H1);
    let n = base["findings"].as_array().unwrap().len();
    assert!(n >= 2);

    let mut removed = base.clone();
    removed["findings"].as_array_mut().unwrap().pop();
    assert_population_reject(&removed, "remove one finding");

    let mut added = base.clone();
    let extra = added["findings"][0].clone();
    added["findings"].as_array_mut().unwrap().push(extra);
    assert_population_reject(&added, "add one finding (duplicate)");

    let mut details = base.clone();
    details["findings"][0]["details"]["words"] = json!(12345);
    assert_population_reject(&details, "change one details value");

    let mut property = base.clone();
    property["findings"][0]["extra"] = json!("x");
    // The exact-shape parse rejects it as `Shape` (earlier than the equality).
    let err = admit(&bytes(&property), deadline()).expect_err("extra property");
    assert_eq!(err.error, InspectionError::Shape, "extra property: {err}");

    let mut dropped = base.clone();
    let rules = dropped["findings"].as_array().unwrap().clone();
    dropped["findings"] = Value::Array(
        rules
            .into_iter()
            .filter(|f| f["rule"] != "missing_h1")
            .collect(),
    );
    assert!(
        dropped["findings"].as_array().unwrap().len() < n,
        "fixture has missing_h1"
    );
    assert_population_reject(&dropped, "drop missing_h1");
}

#[test]
fn reordered_findings_still_admit_as_a_multiset() {
    let mut report = load(MISSING_H1);
    report["findings"].as_array_mut().unwrap().reverse();
    admit(&bytes(&report), deadline()).expect("order is not significant (Q5)");
}

#[test]
fn idn_request_host_rejects() {
    let mut report = load(MISSING_H1);
    report["request"]["url"] = json!("https://b\u{fc}cher.example/");
    assert!(admit(&bytes(&report), deadline()).is_err());
}

#[test]
fn expired_deadline_rejects_with_deadline() {
    let raw = fs::read(fixtures().join(MISSING_H1)).unwrap();
    let err = admit(&raw, Instant::now()).expect_err("expired");
    assert_eq!(err.error, InspectionError::Deadline);
}

#[test]
fn evidence_v1_admits_and_does_not_change_the_summary() {
    let base = load(MISSING_H1);
    let plain = admit(&bytes(&base), deadline()).unwrap();
    let mut with = base.clone();
    // Content that would break equality if it were read as findings.
    with["evidence_contract"] = json!({
        "version": 1,
        "findings": [{"rule": "not_a_rule"}],
        "evaluations": [],
    });
    let admitted = admit(&bytes(&with), deadline()).expect("evidence v1 admits");
    assert_eq!(admitted.summary.canonical, plain.summary.canonical);
}

#[test]
fn invalid_evidence_rejects_at_inspection() {
    let base = load(MISSING_H1);
    let mut cases: Vec<(&str, Value)> = vec![
        ("null", Value::Null),
        ("array", json!([1])),
        ("string", json!("v1")),
        ("version 2", json!({"version": 2})),
        ("no version", json!({"x": 1})),
    ];
    cases.push((
        "over 1 MiB",
        json!({"version": 1, "pad": "a".repeat(1_048_576)}),
    ));
    for (label, evidence) in cases {
        let mut report = base.clone();
        report["evidence_contract"] = evidence;
        let err = admit(&bytes(&report), deadline()).expect_err(label);
        assert_eq!(err.stage, AdmissionStage::Inspection, "{label}: {err}");
    }
}

#[test]
fn absent_evidence_admits() {
    let base = load(MISSING_H1);
    assert!(base.get("evidence_contract").is_none());
    admit(&bytes(&base), deadline()).unwrap();
}

#[test]
fn validator_revision_matches_the_h2_seed_when_present() {
    assert_eq!(
        VALIDATOR_REVISION,
        "s14-wire-1/full-population-1/evidence-v1"
    );
    let migration = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../supabase/migrations/20261211000000_s14_schema4_admission.sql");
    // H2 lands the migration later; once it exists the literal must match.
    if let Ok(sql) = fs::read_to_string(migration) {
        assert!(sql.contains(VALIDATOR_REVISION), "H2 seed drifted");
    }
}
