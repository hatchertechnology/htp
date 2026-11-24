use htp_s14_receiver::check_compatibility_findings;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn check(v: &Value) -> bool {
    check_compatibility_findings(
        &serde_json::to_vec(v).unwrap(),
        Instant::now() + Duration::from_secs(30),
    )
    .is_ok()
}
#[test]
fn reconstructed_fields_and_unsupported_details() {
    let original: Value =
        serde_json::from_str(include_str!("fixtures/v4-candidate-complete.json")).unwrap();
    assert!(check(&original));
    let i = original["findings"]
        .as_array()
        .unwrap()
        .iter()
        .position(|f| f["rule"] == "little_content")
        .unwrap();
    for field in ["key", "url", "severity", "evidence", "evidence_items"] {
        let mut changed = original.clone();
        changed["findings"][i][field] = json!("ordinary changed value");
        assert!(!check(&changed), "{field}");
    }
    let mut changed = original.clone();
    changed["findings"][i]["details"]["classification"] = json!("policy_violation");
    assert!(!check(&changed));
    changed = original.clone();
    changed["findings"][i]["details"]["note"] = json!("ordinary retained metadata");
    assert!(check(&changed));
    changed = original.clone();
    changed["findings"].as_array_mut().unwrap().remove(i);
    assert!(!check(&changed));
    changed = original.clone();
    changed["findings"][i]["rule"] = json!("missing_hreflang_xdefault");
    assert!(!check(&changed));
}
#[test]
fn intent_and_observation_are_distinct() {
    let mut report: Value =
        serde_json::from_str(include_str!("fixtures/v4-candidate-complete.json")).unwrap();
    report["pages"][0]["robots"] = json!("noindex");
    assert!(check(&report)); // Observation alone creates no compatibility violation.
    report["policy_guidance"]["config"]["require_indexable"] = json!(true);
    assert!(!check(&report)); // Explicit intent requires the producer finding.
}

#[test]
fn inherited_depth_and_flag_evidence() {
    use sha2::{Digest, Sha256};
    let mut report: Value =
        serde_json::from_str(include_str!("fixtures/v4-candidate-complete.json")).unwrap();
    let url = report["pages"][0]["url"].as_str().unwrap().to_owned();
    report["pages"][0]["depth"] = json!(5);
    report["pages"][0]["flags"] = json!(["deep_page"]);
    assert!(!check(&report));
    let page = &report["pages"][0];
    let finding = json!({"key":format!("{:x}", Sha256::digest(format!("deep_page\n{url}").as_bytes())),"rule":"deep_page","severity":"warning","url":url,"evidence":"5","evidence_items":["5","deep_page"],"details":{"status":page["status"],"bytes":page["bytes"],"ttfb_ms":page["ttfb_ms"],"words":page["words"],"dom_nodes":page["dom_nodes"],"observation_count":2}});
    report["findings"].as_array_mut().unwrap().push(finding);
    assert!(check(&report));
    let last = report["findings"].as_array().unwrap().len() - 1;
    report["findings"][last]["details"]["observation_count"] = json!(1);
    assert!(!check(&report));
}
