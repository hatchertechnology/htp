use htp_s14_receiver::{InspectionError, check_reconstructed_rules};
use std::time::{Duration, Instant};
fn check(v: &serde_json::Value) -> Result<(), InspectionError> {
    check_reconstructed_rules(
        &serde_json::to_vec(v).unwrap(),
        Instant::now() + Duration::from_secs(30),
    )
}
fn fixture(name: &str) -> serde_json::Value {
    let p = format!(
        "{}/tests/fixtures/v4-candidate-{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}
#[test]
fn fixtures_and_inconsistencies() {
    for name in ["intent", "complete", "partial"] {
        let v = fixture(name);
        assert_eq!(check(&v), Ok(()), "{name}");
        let mut x = v.clone();
        x["policy_guidance"]["candidate"]["coverage"][8]["omitted"] = 999.into();
        assert_eq!(check(&x), Err(InspectionError::SemanticMismatch));
        let mut x = v.clone();
        x["policy_guidance"]["manifest"][12]["candidates"] = serde_json::json!([]);
        assert_eq!(check(&x), Err(InspectionError::SemanticMismatch));
        let mut x = v.clone();
        x["policy_guidance"]["candidate"]["records"]
            .as_array_mut()
            .unwrap()
            .reverse();
        assert_eq!(check(&x), Err(InspectionError::SemanticMismatch));
    }
}
#[test]
fn synthetic_noindex_fact_and_target_status() {
    let mut v = fixture("complete");
    v["pages"][0]["robots"] = "noindex".into();
    let records = v["policy_guidance"]["candidate"]["records"]
        .as_array_mut()
        .unwrap();
    let r = records
        .iter_mut()
        .find(|r| {
            r["category"] == "observation"
                && r["rule_id"] == "noindex"
                && r["source_locator"] == "/pages/0/robots"
        })
        .unwrap();
    r["observed_fact"] = true.into();
    assert_eq!(check(&v), Ok(()));
    let mut changed = v.clone();
    let records = changed["policy_guidance"]["candidate"]["records"]
        .as_array_mut()
        .unwrap();
    let r = records
        .iter_mut()
        .find(|r| {
            r["category"] == "observation"
                && r["rule_id"] == "noindex"
                && r["source_locator"] == "/pages/0/robots"
        })
        .unwrap();
    r["observed_fact"] = false.into();
    assert_eq!(check(&changed), Err(InspectionError::SemanticMismatch));
    let mut changed = v.clone();
    changed["pages"][3]["status"] = 404.into();
    assert_eq!(check(&changed), Err(InspectionError::SemanticMismatch));
}
#[test]
fn advisory_row_order_is_global() {
    let mut v = fixture("complete");
    let records = v["policy_guidance"]["candidate"]["records"]
        .as_array_mut()
        .unwrap();
    records.swap(0, 4);
    assert_eq!(check(&v), Err(InspectionError::SemanticMismatch));
}
#[test]
fn missing_status_cannot_claim_a_completed_edge() {
    let mut v = fixture("partial");
    assert_eq!(check(&v), Ok(()));
    let records = v["policy_guidance"]["candidate"]["records"]
        .as_array_mut()
        .unwrap();
    let missing = records
        .iter_mut()
        .find(|r| r["rule_id"] == "external_link" && r["context_locator"] == "/pages/0/links/0")
        .unwrap();
    missing["reason"] = "external_target_not_fetched".into();
    let fetched = records
        .iter_mut()
        .find(|r| r["rule_id"] == "external_link" && r["context_locator"] == "/pages/0/links/1")
        .unwrap();
    fetched["eligibility"] = "eligible".into();
    fetched["attempt"] = "completed".into();
    fetched["outcome"] = "observed".into();
    fetched["actual"] = "source".into();
    fetched["confidence"] = "high".into();
    fetched["reason"] = serde_json::Value::Null;
    fetched["source_locator"] = "/pages/0/links/1".into();
    fetched["target_locator"] = "/pages/3/status".into();
    fetched["observed_fact"] = 200.into();
    let c = &mut v["policy_guidance"]["candidate"]["coverage"][12];
    c["eligibility_counts"] = serde_json::json!({"eligible":1,"unknown":1});
    c["attempt_counts"] = serde_json::json!({"completed":1,"not_attempted":1});
    c["outcomes"] = serde_json::json!({"observed":1,"unknown":1});
    c["unknown_reasons"] = serde_json::json!({"external_target_not_fetched":1});
    assert_eq!(check(&v), Err(InspectionError::SemanticMismatch));
}
#[test]
fn pinned_non_html_and_non_success_source_cases() {
    use sha2::{Digest, Sha256};
    for (bytes, expected) in [
        (
            include_bytes!("source-cases/v4-candidate-edge-source_non_html.json").as_slice(),
            "683b41bf058104646fbf80454ba28cb07c6acfa8307b5fcc086c77d25a0c75f8",
        ),
        (
            include_bytes!("source-cases/v4-candidate-edge-source_non_success.json").as_slice(),
            "f601bdfb04e237af9b437a05f68e513558ac2b421719d4a7c2e8106c6c5a45a7",
        ),
    ] {
        assert_eq!(format!("{:x}", Sha256::digest(bytes)), expected);
        assert_eq!(
            check_reconstructed_rules(bytes, Instant::now() + Duration::from_secs(30)),
            Ok(())
        );
    }
}
