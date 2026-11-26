use htp_s14_receiver::{InspectionError, check_consistency};
use std::time::{Duration, Instant};

fn check(v: &serde_json::Value) -> Result<htp_s14_receiver::ConsistencyEvidence, InspectionError> {
    check_consistency(
        &serde_json::to_vec(v).unwrap(),
        Instant::now() + Duration::from_secs(30),
    )
}
#[test]
fn pinned_reports_and_checked_mutations() {
    for name in ["intent", "complete", "partial"] {
        let path = format!(
            "{}/tests/fixtures/v4-candidate-{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let mut v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let evidence = check(&v).unwrap();
        assert_eq!(evidence.rules_checked, 13);
        let original = v.clone();
        v["policy_guidance"]["candidate"]["coverage"][0]["emitted"] = 999.into();
        assert!(matches!(check(&v), Err(InspectionError::SemanticMismatch)));
        v = original;
        v["policy_guidance"]["catalog"][0]["explanation"] = "changed".into();
        assert!(matches!(check(&v), Err(InspectionError::SemanticMismatch)));
    }
}
/// The omitted-record path (the retired `mixed-omitted` coverage) now runs on
/// the S2 schema-4 `mixed-caps-exceeded` report, which omits records at the cap.
#[test]
fn omitted_records_are_counted_on_the_schema4_cap_report() {
    let path = format!(
        "{}/tests/fixtures/s14-schema4-v1/mixed-caps-exceeded.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let evidence = check(&v).unwrap();
    assert_eq!(evidence.rules_checked, 13);
    assert!(evidence.omitted_records > 0);
}
