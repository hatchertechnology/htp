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
/// A partial claim with every rule `unknown`: the summary stage derives and
/// accepts any finding set, so only `findings_match` can reject a wrong one.
const PARTIAL_UNKNOWN: &str = "s14-finding-coverage-v1/partial-missing-h1.json";

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
    // With a complete coverage claim the coverage parse rejects it first, as
    // `Shape` at the summary stage; the Population-stage case (no complete
    // claim) is in `population_stage_compares_finding_content`.
    assert_rejects_at(
        &property,
        AdmissionStage::Summary,
        InspectionError::Shape,
        "extra property",
    );

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

fn assert_rejects_at(report: &Value, stage: AdmissionStage, error: InspectionError, label: &str) {
    let err = admit(&bytes(report), deadline()).expect_err(label);
    assert_eq!((err.stage, err.error), (stage, error), "{label}: {err}");
}

/// The Population stage is the only gate here (summary and coverage still
/// pass), so each mutation proves `findings_match` compares content, not count.
#[test]
fn population_stage_compares_finding_content() {
    use AdmissionStage::Population;
    use InspectionError::SemanticMismatch;
    let base = load(PARTIAL_UNKNOWN);
    admit(&bytes(&base), deadline()).expect("unmutated report admits");
    let n = base["findings"].as_array().unwrap().len();
    assert!(n >= 3);
    // The summary stage alone accepts every mutation below (so a Population
    // rejection cannot be a summary/coverage rejection in disguise).
    let reject = |report: &Value, label: &str| {
        derive_saved_summary(&bytes(report), deadline())
            .unwrap_or_else(|e| panic!("{label}: summary stage must pass, got {e}"));
        assert_rejects_at(report, Population, SemanticMismatch, label);
    };

    let mut missing = base.clone();
    missing["findings"].as_array_mut().unwrap().pop();
    reject(&missing, "missing finding");

    let mut extra = base.clone();
    let mut other = extra["findings"][0].clone();
    other["key"] = json!("f".repeat(64));
    extra["findings"].as_array_mut().unwrap().push(other);
    reject(&extra, "extra finding");

    let mut details = base.clone();
    details["findings"][0]["details"]["words"] = json!(12345);
    reject(&details, "changed details value (same length)");

    let mut field = base.clone();
    field["findings"][1]["evidence"] = json!("changed evidence");
    reject(&field, "changed scalar field (same length)");

    let mut key = base.clone();
    key["findings"][2]["key"] = json!("0".repeat(64));
    reject(&key, "changed key (same length)");

    let mut property = base.clone();
    property["findings"][0]["extra"] = json!("x");
    reject(&property, "extra property on a finding");
}

/// Same length, same members, different multiplicity: `[A, A, C, D]` against
/// `[A, B, C, D]` is not equal as a multiset (and not as a set either).
#[test]
fn duplicate_multiplicity_is_not_a_set_or_a_length_check() {
    let base = load(PARTIAL_UNKNOWN);
    let mut dup = base.clone();
    let first = dup["findings"][0].clone();
    dup["findings"][1] = first;
    assert_eq!(
        dup["findings"].as_array().unwrap().len(),
        base["findings"].as_array().unwrap().len()
    );
    derive_saved_summary(&bytes(&dup), deadline()).expect("summary stage passes");
    assert_rejects_at(
        &dup,
        AdmissionStage::Population,
        InspectionError::SemanticMismatch,
        "duplicate multiplicity",
    );
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
    let err = admit(&bytes(&report), deadline()).expect_err("IDN host");
    assert_eq!(err.stage, AdmissionStage::Inspection, "{err}");
    assert_eq!(err.error, InspectionError::Url, "{err}");
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
    let cases: Vec<(&str, Value)> = vec![
        ("null", Value::Null),
        ("array", json!([1])),
        ("string", json!("v1")),
        ("version 2", json!({"version": 2})),
        ("no version", json!({"x": 1})),
    ];
    for (label, evidence) in cases {
        let mut report = base.clone();
        report["evidence_contract"] = evidence;
        let err = admit(&bytes(&report), deadline()).expect_err(label);
        assert_eq!(err.stage, AdmissionStage::Inspection, "{label}: {err}");
    }
}

/// Many short members (each under the 16 KiB string bound) so the 1 MiB
/// evidence rule itself fires, as `Bounds`, and not the raw string scanner.
#[test]
fn evidence_over_one_mib_is_a_bounds_rejection() {
    let base = load(MISSING_H1);
    let mut members = serde_json::Map::new();
    members.insert("version".into(), json!(1));
    for i in 0..1100 {
        members.insert(format!("m{i}"), json!("a".repeat(1000)));
    }
    let mut report = base;
    report["evidence_contract"] = Value::Object(members);
    assert_rejects_at(
        &report,
        AdmissionStage::Inspection,
        InspectionError::Bounds,
        "over 1 MiB",
    );
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
    // VACUOUS UNTIL H2 MERGES: the migration does not exist in this tree, so
    // the file-reading branch below is skipped and the assertion above only
    // checks the constant against itself. The tie is enforced on H2's side
    // (its test and runner assert this same literal); once H2 lands, this
    // branch starts reading the seed and fails on any drift.
    if let Ok(sql) = fs::read_to_string(migration) {
        assert!(sql.contains(VALIDATOR_REVISION), "H2 seed drifted");
    }
}
