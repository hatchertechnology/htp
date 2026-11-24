use htp_s14_receiver::check_source_bindings;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/v4-candidate-complete.json")).unwrap()
}
fn check(v: &Value) -> bool {
    check_source_bindings(
        &serde_json::to_vec(v).unwrap(),
        Instant::now() + Duration::from_secs(30),
    )
    .is_ok()
}
#[test]
fn producer_digest_vectors_and_manifest_order() {
    let v = fixture();
    assert!(check(&v));
    let mut changed = v.clone();
    changed["request"]["binding_generation"] = 2.into();
    assert!(!check(&changed));
    changed["policy_guidance"]["candidate"]["scope_digest"] =
        "sha256:a246aae7be8098498b1b1b99e888c3f771fd412157df850c6b34f453dc2ec06a".into();
    assert!(check(&changed));
    let mut changed = v.clone();
    changed["request"]["website_id"] = "00000000-0000-4000-8000-000000000999".into();
    assert!(!check(&changed));
    changed["policy_guidance"]["candidate"]["scope_digest"] =
        "sha256:f3b1fde9be926e49815efba2d223d0306050b489823e5502e3c68f61ce23b478".into();
    assert!(check(&changed));
    let mut changed = v.clone();
    changed["policy_guidance"]["manifest"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert!(check(&changed));
    changed["policy_guidance"]["manifest"][0]["candidates"] = json!([]);
    assert!(check(&changed));
    let mut changed = v.clone();
    changed["policy_guidance"]["manifest"][0]["expected_pointer"] = "/policy/title_max".into();
    assert!(!check(&changed));
    changed["policy_guidance"]["candidate"]["manifest_digest"] =
        "sha256:c4412ecdd9f8ae7cc1d3392711ec24e224fdf8467b59c2c4df30f2e792cf00b9".into();
    assert!(check(&changed));
}
fn interval(v: &mut Value, start: &str, end: &str) {
    v["started_at"] = start.into();
    v["finished_at"] = end.into();
    v["policy_guidance"]["candidate"]["observed_at"]["started_at"] = start.into();
    v["policy_guidance"]["candidate"]["observed_at"]["finished_at"] = end.into();
}
#[test]
fn interval_offsets_dates_and_exact_fraction_order() {
    let mut v = fixture();
    interval(
        &mut v,
        "2024-02-29T23:00:00.12345678901234567890-01:00",
        "2024-03-01t00:00:00.12345678901234567891z",
    );
    assert!(check(&v));
    interval(
        &mut v,
        "2024-02-29T23:00:00.12345678901234567891-01:00",
        "2024-03-01T00:00:00.12345678901234567890Z",
    );
    assert!(!check(&v));
    for invalid in [
        "2023-02-29T00:00:00Z",
        "0000-01-01T00:00:00Z",
        "2024-01-01T00:00:60Z",
        "2024-01-01T00:00:00",
        "2024-01-01T00:00:00+24:00",
    ] {
        interval(&mut v, invalid, invalid);
        assert!(!check(&v), "{invalid}");
    }
    interval(&mut v, "2024-01-01T00:00:00+23:59", "2024-01-01T00:00:00Z");
    assert!(check(&v));
    v["policy_guidance"]["candidate"]["observed_at"]["started_at"] = "2024-01-01T00:00:00Z".into();
    assert!(!check(&v));
}
