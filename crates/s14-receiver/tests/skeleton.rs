use htp_s14_receiver::{
    InspectionError, admitted_url, budget, inspect, roles::*, validate_for_admission,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    time::{Duration, Instant},
};
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
#[test]
fn pinned_subset_bytes_are_not_regenerated_or_reclassified_as_frozen() {
    let m: serde_json::Value = serde_json::from_slice(&fixture("manifest.json")).unwrap();
    for f in m["files"].as_array().unwrap() {
        let b = fixture(f["path"].as_str().unwrap());
        assert_eq!(b.len() as u64, f["bytes"].as_u64().unwrap());
        assert_eq!(format!("{:x}", Sha256::digest(&b)), f["sha256"]);
    }
}
#[test]
fn typed_metadata_inspection_does_not_issue_an_admission_result() {
    for name in [
        "complete",
        "partial",
        "mixed-omitted",
        "intent",
        "edge-source_missing_status",
        "unicode-equal",
    ] {
        let raw = fixture(&format!("v4-candidate-{name}.json"));
        let checked = inspect(&raw, deadline()).unwrap();
        assert_eq!(checked.raw_bytes, raw.len());
        assert!(checked.page_count > 0);
        assert!(checked.record_count <= 512);
        assert_eq!(checked.coverage_count, 13);
        assert!(matches!(
            validate_for_admission(&raw, deadline()),
            Err(InspectionError::SemanticValidationNotImplemented)
        ));
    }
}
#[test]
fn malformed_numeric_duplicate_and_url_profiles_are_rejected() {
    for name in [
        "invalid-schema-fraction.json",
        "invalid-escaped-duplicate-nested.json",
        "v4-candidate-url-normalization.json",
    ] {
        assert!(inspect(&fixture(name), deadline()).is_err(), "{name}");
    }
}
#[test]
fn inspection_rejects_expired_budget_bytes_and_metadata_mutation() {
    let raw = fixture("v4-candidate-complete.json");
    assert_eq!(
        inspect(&raw, Instant::now()).unwrap_err(),
        InspectionError::Deadline
    );
    assert_eq!(
        inspect(
            &vec![b' '; htp_s14_receiver::MAX_REPORT_BYTES + 1],
            deadline()
        )
        .unwrap_err(),
        InspectionError::ByteLimit
    );
    let mut r: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    r["request"]["max_duration_seconds"] = serde_json::json!(999_999);
    assert!(inspect(&serde_json::to_vec(&r).unwrap(), deadline()).is_err());
}
#[test]
fn source_json_key_names_do_not_impose_integer_metadata_rules() {
    let mut r: serde_json::Value =
        serde_json::from_slice(&fixture("v4-candidate-complete.json")).unwrap();
    r["findings"][0]["details"]["count"] = serde_json::json!(1.5);
    r["findings"][0]["details"]["status"] = serde_json::json!(-0.5);
    assert!(inspect(&serde_json::to_vec(&r).unwrap(), deadline()).is_ok());
}
#[test]
fn raw_unicode_key_and_policy_string_bounds_are_path_specific() {
    let raw = String::from_utf8(fixture("v4-candidate-complete.json")).unwrap();
    for changed in [
        raw.replacen(
            "\"schema_version\":4",
            "\"schema_version\":4,\"schema_versio\\u006e\":4",
            1,
        ),
        raw.replacen("\"title\":", "\"title\":\"\\ud800\",\"title\":", 1),
    ] {
        assert!(inspect(changed.as_bytes(), deadline()).is_err());
    }
    let mut r: serde_json::Value = serde_json::from_str(&raw).unwrap();
    r["findings"][0]["details"]["policy_canonical_json"] = serde_json::json!("x".repeat(16385));
    assert!(inspect(&serde_json::to_vec(&r).unwrap(), deadline()).is_err());
}
#[test]
fn receiver_admission_matches_the_pinned_42_url_profile() {
    let matrix: serde_json::Value = serde_json::from_slice(&fixture("url-cases-r2.json")).unwrap();
    for c in matrix["cases"].as_array().unwrap() {
        let u = admitted_url(c["stored"].as_str().unwrap());
        if c["expected"].as_str().unwrap().starts_with("reject") {
            assert!(u.is_err(), "{c}");
        } else {
            let u = u.unwrap();
            let scope = if u.host_str() == Some("example.com") && u.port().is_none() {
                "in_scope"
            } else {
                "out_of_scope"
            };
            assert_eq!(scope, c["expected"]);
        }
    }
}
#[test]
fn model_separates_grant_rls_and_commit_execution_identity() {
    assert!(!row_access(true, false));
    assert!(!row_access(false, true));
    assert!(row_access(true, true));
    for role in [
        Principal::Anon,
        Principal::Authenticated,
        Principal::ServiceRole,
        Principal::Ingress,
        Principal::ProofWriter,
    ] {
        assert!(!may_execute(role, Operation::DirectSchema4Insert));
    }
    assert!(may_execute(
        Principal::CommitOwner,
        Operation::DirectSchema4Insert
    ));
    assert!(may_execute(Principal::ProofWriter, Operation::PersistProof));
    assert!(!may_execute(Principal::ProofWriter, Operation::Activate));
    assert!(!may_execute(
        Principal::ProofWriter,
        Operation::CommitWorker
    ));
}
#[test]
fn revoked_validator_can_ack_prior_commit_but_never_override_auth_or_session_loss() {
    let c = Context {
        worker: WorkerScope::Current,
        session: SessionFence::Live,
        ..Context::default()
    };
    assert_eq!(decide(c, true), Decision::PriorCommitReceipt);
    assert_eq!(decide(c, false), Decision::Denied);
    assert_eq!(
        decide(
            Context {
                worker: WorkerScope::Unavailable,
                ..c
            },
            true
        ),
        Decision::Denied
    );
    assert_eq!(
        decide(
            Context {
                session: SessionFence::Lost,
                ..c
            },
            true
        ),
        Decision::Denied
    );
    let ready = Context {
        api: Gate::On,
        db: Gate::On,
        revision: Revision::Approved,
        proof: Proof::ScopedUnexpired,
        ..c
    };
    assert_eq!(decide(ready, false), Decision::NewInsertModelOnly);
    assert_eq!(
        decide(
            Context {
                revision: Revision::Disallowed,
                ..ready
            },
            false
        ),
        Decision::Denied
    );
}
#[test]
fn stage_allowance_never_resets_the_global_deadline() {
    assert_eq!(budget::STAGES_MS.iter().sum::<u64>(), 25_000);
    let start = Instant::now();
    let d = budget::Deadline::new(start);
    assert_eq!(
        d.allowance(start + Duration::from_secs(24), Duration::from_secs(15)),
        Some(Duration::from_secs(1))
    );
    assert_eq!(
        d.allowance(start + Duration::from_secs(25), Duration::from_secs(15)),
        None
    );
}

#[test]
fn exact_raw_cap_and_depth_boundaries_remain_inclusive() {
    let raw = String::from_utf8(fixture("v4-candidate-complete.json")).unwrap();
    let mut exact = raw.clone();
    exact.extend(std::iter::repeat_n(
        ' ',
        htp_s14_receiver::MAX_REPORT_BYTES - raw.len(),
    ));
    assert!(inspect(exact.as_bytes(), deadline()).is_ok());
    exact.push(' ');
    assert_eq!(
        inspect(exact.as_bytes(), deadline()).unwrap_err(),
        InspectionError::ByteLimit
    );
    for (n, ok) in [(60, true), (61, false)] {
        let nested = format!("{}0{}", "[".repeat(n), "]".repeat(n));
        let changed = raw.replacen(
            "\"details\":{",
            &format!("\"details\":{{\"depth_probe\":{nested},"),
            1,
        );
        assert_eq!(inspect(changed.as_bytes(), deadline()).is_ok(), ok);
    }
}
#[test]
fn opaque_source_numbers_are_not_coerced_into_f64_or_named_integer_metadata() {
    let raw = String::from_utf8(fixture("v4-candidate-complete.json")).unwrap();
    let changed = raw.replacen(
        "\"details\":{",
        "\"details\":{\"count\":1e400,\"status\":-0.5,",
        1,
    );
    assert!(inspect(changed.as_bytes(), deadline()).is_ok());
    assert!(htp_s14_receiver::check_source_bindings(changed.as_bytes(), deadline()).is_ok());
    assert!(htp_s14_receiver::check_reconstructed_rules(changed.as_bytes(), deadline()).is_ok());
}
