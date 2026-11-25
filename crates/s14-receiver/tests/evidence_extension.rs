//! E-r: the optional schema-4 `evidence_contract` extension.
//!
//! Shape-level contract only: absent evidence inspects, a v1 object inspects,
//! and non-object, non-v1 or over-cap evidence is rejected. The evidence
//! content itself is opaque to this crate; SQL validates it on admission.
use htp_s14_receiver::{InspectionError, inspect, validate_for_admission};
use std::{
    fs,
    time::{Duration, Instant},
};
// Mirrors the private cap in `src/shape.rs`; the byte-level rule is what these
// tests pin, not the constant itself.
const MAX_EVIDENCE_BYTES: usize = 1_048_576;

fn fixture(name: &str) -> Vec<u8> {
    fs::read(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
/// Embed `evidence` verbatim as the first member of the report object. The
/// receiver stores `Option<&RawValue>`, so the bytes must round-trip untouched.
fn with_evidence(report: &[u8], evidence: &str) -> Vec<u8> {
    let s = std::str::from_utf8(report).unwrap();
    assert!(s.starts_with('{'));
    format!("{{\"evidence_contract\":{},{}", evidence, &s[1..]).into_bytes()
}
/// Evidence JSON of an exact byte length. `raw::check` caps single strings at
/// 16 KiB, so the bulk is carried by many short `"kNNNNN":0` members instead
/// of one pad string, and a final `"p":"<zeros>"` member lands the length
/// exactly.
fn evidence_of_len(target: usize) -> String {
    assert!(target >= 42);
    let mut s = String::from("{\"version\":1,");
    let mut i = 0;
    // Keep room for one more member (11) plus the final member's minimum
    // footprint (comma + `"p":""}` = 8), so the closing member never
    // underflows and its pad stays tiny.
    while s.len() + 29 <= target {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!("\"k{i:05}\":0"));
        i += 1;
    }
    let pad = target - s.len() - 8;
    s.push(',');
    s.push_str(&format!("\"p\":\"{}\"}}", "0".repeat(pad)));
    assert_eq!(s.len(), target);
    s
}
#[test]
fn report_without_evidence_contract_still_inspects() {
    let raw = fixture("v4-candidate-complete.json");
    let checked = inspect(&raw, deadline()).unwrap();
    assert!(checked.page_count > 0);
}
#[test]
fn evidence_v1_object_inspects_and_leaves_the_rest_of_the_shape_alone() {
    let raw = fixture("v4-candidate-complete.json");
    let bare = inspect(&raw, deadline()).unwrap();
    let evidence = r#"{"version":1}"#;
    let with = with_evidence(&raw, evidence);
    let checked = inspect(&with, deadline()).unwrap();
    // The evidence is excluded from the shape outcome: the same pages,
    // records and coverage are seen with and without it.
    assert_eq!(checked.page_count, bare.page_count);
    assert_eq!(checked.record_count, bare.record_count);
    assert_eq!(checked.coverage_count, bare.coverage_count);
    assert_eq!(checked.raw_bytes, with.len());
    // The admission stub is untouched: evidence never becomes a proof.
    assert!(matches!(
        validate_for_admission(&with, deadline()),
        Err(InspectionError::SemanticValidationNotImplemented)
    ));
}
#[test]
fn evidence_that_is_not_an_object_is_rejected() {
    let raw = fixture("v4-candidate-complete.json");
    for evidence in ["[1,2]", "\"x\"", "42", "true"] {
        let with = with_evidence(&raw, evidence);
        assert!(inspect(&with, deadline()).is_err(), "{evidence}");
    }
}
#[test]
fn evidence_version_must_be_exactly_one() {
    let raw = fixture("v4-candidate-complete.json");
    for evidence in [
        r#"{"version":2}"#,
        r#"{"version":0}"#,
        r"{}",
        r#"{"version":"1"}"#,
        r#"{"version":1.0}"#,
    ] {
        let with = with_evidence(&raw, evidence);
        assert!(inspect(&with, deadline()).is_err(), "{evidence}");
    }
}
#[test]
fn evidence_over_the_cap_is_rejected() {
    let raw = fixture("v4-candidate-complete.json");
    let evidence = evidence_of_len(MAX_EVIDENCE_BYTES + 1);
    let with = with_evidence(&raw, &evidence);
    assert!(matches!(
        inspect(&with, deadline()),
        Err(InspectionError::Bounds)
    ));
}
#[test]
fn evidence_exactly_at_the_cap_is_accepted() {
    let raw = fixture("v4-candidate-complete.json");
    let evidence = evidence_of_len(MAX_EVIDENCE_BYTES);
    let with = with_evidence(&raw, &evidence);
    inspect(&with, deadline()).unwrap();
}
