use htp_s14_receiver::{InspectionError, check_scalar_advisories};
use std::time::{Duration, Instant};
fn check(v: &serde_json::Value) -> Result<(), InspectionError> {
    check_scalar_advisories(
        &serde_json::to_vec(v).unwrap(),
        Instant::now() + Duration::from_secs(30),
    )
}
fn fixture(name: &str) -> serde_json::Value {
    let path = format!(
        "{}/tests/fixtures/v4-candidate-{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
#[test]
fn pinned_and_source_mutations() {
    for name in ["intent", "complete", "partial", "mixed-omitted"] {
        let v = fixture(name);
        assert_eq!(check(&v), Ok(()), "{name}");
        let mut changed = v.clone();
        changed["policy_guidance"]["candidate"]["records"][0]["outcome"] =
            "advisory_not_triggered".into();
        if name == "intent" || name == "complete" {
            assert_eq!(check(&changed), Err(InspectionError::SemanticMismatch));
        }
        let mut changed = v.clone();
        changed["pages"][0]["title"] = "A title with enough characters".into();
        if name == "intent" || name == "complete" {
            assert_eq!(check(&changed), Err(InspectionError::SemanticMismatch));
        }
        let mut changed = v.clone();
        changed["policy_guidance"]["manifest"][0]["candidates"][0] = "sha256:wrong".into();
        assert_eq!(check(&changed), Err(InspectionError::SemanticMismatch));
        let mut changed = v.clone();
        changed["policy_guidance"]["candidate"]["coverage"][0]["unknown_reasons"] =
            serde_json::json!({"source_unavailable":999});
        assert_eq!(check(&changed), Err(InspectionError::SemanticMismatch));
    }
}
#[test]
fn synthetic_threshold_equality() {
    let mut v = fixture("complete");
    v["pages"][0]["title"] = "123456789012345".into();
    v["policy_guidance"]["candidate"]["records"][0]["outcome"] = "advisory_not_triggered".into();
    v["policy_guidance"]["candidate"]["coverage"][0]["outcomes"] =
        serde_json::json!({"advisory_not_triggered":1,"not_applicable":3});
    assert_eq!(check(&v), Ok(()));
    v["policy_guidance"]["candidate"]["records"][0]["source_locator"] = "/pages/1/title".into();
    assert_eq!(check(&v), Err(InspectionError::SemanticMismatch));
}
#[test]
fn synthetic_record_cap_counts_omitted_source_states() {
    use sha2::{Digest, Sha256};
    fn hash(s: &str) -> String {
        format!("sha256:{:x}", Sha256::digest(s.as_bytes()))
    }
    let mut v = fixture("mixed-omitted");
    let rules = [
        "short_title",
        "long_title",
        "short_description",
        "long_description",
        "little_content",
        "too_many_links",
    ];
    let existing = v["policy_guidance"]["candidate"]["records"]
        .as_array()
        .unwrap()
        .clone();
    let page = v["pages"][0].clone();
    let mut new_ids = Vec::new();
    for i in 0..31 {
        let url = format!("https://example.com/synthetic-{i}");
        let mut p = page.clone();
        p["url"] = url.clone().into();
        v["pages"].as_array_mut().unwrap().push(p);
        new_ids.push(hash(&format!("seosmith-entity-v1\npage\n{url}")));
    }
    let mut emitted = Vec::new();
    for (row, rule) in rules.iter().enumerate() {
        let originals: Vec<_> = existing
            .iter()
            .filter(|r| r["category"] == "advisory" && r["rule_id"] == *rule)
            .cloned()
            .collect();
        let mut all = originals.clone();
        for id in &new_ids {
            let mut record = originals[0].clone();
            record["entity_id"] = id.clone().into();
            record["record_id"] = hash(&format!(
                "seosmith-record-v1\nadvisory\n{rule}\ns14-1\n{id}\nself"
            ))
            .into();
            all.push(record);
        }
        v["policy_guidance"]["manifest"][row]["candidates"]
            .as_array_mut()
            .unwrap()
            .extend(new_ids.iter().cloned().map(Into::into));
        let keep = (512usize - emitted.len()).min(all.len());
        emitted.extend(all.into_iter().take(keep));
        let c = &mut v["policy_guidance"]["candidate"]["coverage"][row];
        c["candidates"] = 90.into();
        c["emitted"] = keep.into();
        c["omitted"] = (90 - keep).into();
        c["omission_reason"] = if keep < 90 {
            "record_limit".into()
        } else {
            serde_json::Value::Null
        };
        for (field, key) in [
            ("eligibility_counts", "unknown"),
            ("attempt_counts", "not_attempted"),
            ("outcomes", "unknown"),
            ("unknown_reasons", "source_unavailable"),
        ] {
            let n = c[field][key].as_u64().unwrap();
            c[field][key] = (n + 31).into();
        }
    }
    v["policy_guidance"]["candidate"]["records"] = emitted.into();
    assert_eq!(check(&v), Ok(()));
    v["policy_guidance"]["candidate"]["coverage"][5]["unknown_reasons"]["source_unavailable"] =
        1.into();
    assert_eq!(check(&v), Err(InspectionError::SemanticMismatch));
}
