//! WP8c-1 parity test: `admit` and every `check_*` on each wire-2 fixture.
//! Stage and error must equal the fixture manifest (the `SEOsmith` side is
//! compared by `scripts/verify-s14-schema4.py --admit`, which parses the
//! `rejected stage=… error=…` line of `examples/admit.rs`).
mod wire2_common;
use htp_s14_receiver::{
    AdmissionStage, InspectionError, admit, check_consistency, check_reconstructed_rules,
    check_scalar_advisories, check_source_bindings, finding_coverage_batch,
};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};
use wire2_common::*;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/s14-wire2-v1")
}
fn dl() -> Instant {
    Instant::now() + Duration::from_secs(60)
}
fn name(e: InspectionError) -> String {
    format!("{e:?}")
}

#[test]
#[ignore = "writes the fixtures: WIRE2_REGEN=1 cargo test --test wire2_conformance regenerate -- --ignored"]
fn regenerate() {
    assert_eq!(std::env::var("WIRE2_REGEN").as_deref(), Ok("1"));
    let cases = cases();
    for c in &cases {
        let p = dir().join(&c.path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, &c.bytes).unwrap();
    }
    fs::write(dir().join("manifest.json"), manifest_text(&cases)).unwrap();
}

#[test]
fn committed_fixtures_equal_the_generator_and_the_manifest() {
    let cases = cases();
    assert!(cases.len() >= 40, "{} cases", cases.len());
    for c in &cases {
        let on_disk = fs::read(dir().join(&c.path)).unwrap_or_else(|e| panic!("{}: {e}", c.path));
        assert_eq!(on_disk, c.bytes, "{} differs from the generator", c.path);
    }
    let on_disk = fs::read_to_string(dir().join("manifest.json")).unwrap();
    assert_eq!(on_disk, manifest_text(&cases));
    // no orphan files beside the manifest
    let mut listed: Vec<_> = cases.iter().map(|c| c.path.clone()).collect();
    let mut found = Vec::new();
    for sub in ["positive", "negative"] {
        for e in fs::read_dir(dir().join(sub)).unwrap() {
            found.push(format!(
                "{sub}/{}",
                e.unwrap().file_name().to_string_lossy()
            ));
        }
    }
    listed.sort();
    found.sort();
    assert_eq!(found, listed);
}

/// Design section 5: on rejection `examples/admit.rs` prints exactly one last
/// stderr line `rejected stage=<..> error=<..>` and exits 1; the accept line is unchanged.
#[test]
fn admit_example_prints_the_stage_line_for_each_stage() {
    // `cargo run` keeps this independent of the build-dir layout.
    let run = |file: PathBuf| {
        std::process::Command::new(env!("CARGO"))
            .args([
                "run",
                "--locked",
                "-q",
                "-p",
                "htp-s14-receiver",
                "--example",
                "admit",
                "--",
            ])
            .arg(file)
            .output()
            .unwrap()
    };
    for (path, want) in [
        (
            "negative/families-null-v2.json",
            "rejected stage=inspection error=Shape",
        ),
        (
            "negative/manifest-digest-mismatch.json",
            "rejected stage=summary error=SemanticMismatch",
        ),
        (
            "negative/population-duplicate-finding-v2.json",
            "rejected stage=population error=SemanticMismatch",
        ),
    ] {
        let out = run(dir().join(path));
        assert_eq!(out.status.code(), Some(1), "{path}");
        let err = String::from_utf8(out.stderr).unwrap();
        assert_eq!(err.lines().last().unwrap(), want, "{path}");
        assert!(out.stdout.is_empty(), "{path}: no summary on rejection");
    }
    let ok = run(dir().join("positive/complete-small.json"));
    assert!(ok.status.success());
    let err = String::from_utf8(ok.stderr).unwrap();
    assert!(
        err.starts_with(&format!("validator_revision={V2_REV} sha256=")),
        "{err}"
    );
}

#[test]
fn admit_stays_within_the_ten_second_budget_on_the_largest_fixture() {
    let b = fs::read(dir().join("positive/s14-record-limit.json")).unwrap();
    let t = Instant::now();
    admit(&b, dl()).unwrap();
    assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
}

#[test]
fn admit_stage_and_error_match_the_manifest_for_every_fixture() {
    let manifest: Value =
        serde_json::from_slice(&fs::read(dir().join("manifest.json")).unwrap()).unwrap();
    let files = manifest["files"].as_array().unwrap();
    let (mut accepted, mut rejected) = (0, 0);
    let mut mismatches = Vec::new();
    for f in files {
        let path = f["path"].as_str().unwrap();
        let bytes = fs::read(dir().join(path)).unwrap();
        assert_eq!(sha_hex(&bytes), f["sha256"].as_str().unwrap(), "{path}");
        let got = admit(&bytes, dl());
        let expect = &f["expect"];
        if expect["admit"] == true {
            let a = got.unwrap_or_else(|e| panic!("{path}: unexpected rejection {e}"));
            assert_eq!(
                a.validator_revision,
                expect["validator_revision"].as_str().unwrap(),
                "{path}"
            );
            // every independent check agrees
            check_source_bindings(&bytes, dl()).unwrap();
            check_consistency(&bytes, dl()).unwrap();
            check_scalar_advisories(&bytes, dl()).unwrap();
            check_reconstructed_rules(&bytes, dl()).unwrap();
            finding_coverage_batch(&bytes, dl()).unwrap();
            accepted += 1;
        } else {
            let Err(e) = got else {
                mismatches.push(format!("{path}: admitted, expected rejection"));
                continue;
            };
            let have = format!("{} {}", e.stage.as_str(), name(e.error));
            let want = format!(
                "{} {}",
                expect["stage"].as_str().unwrap(),
                expect["error"].as_str().unwrap()
            );
            if have != want {
                mismatches.push(format!("{path}: got `{have}`, want `{want}`"));
            }
            assert!(matches!(
                e.stage,
                AdmissionStage::Inspection | AdmissionStage::Summary | AdmissionStage::Population
            ));
            rejected += 1;
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    assert!(accepted >= 10 && rejected >= 30, "{accepted}/{rejected}");
}

/// Review R2-1: `check_consistency` under v2 equals its v1 twin.
#[test]
fn check_consistency_v2_matches_the_v1_twin() {
    for (v1, v2) in [
        ("complete-clean.json", "positive/complete-small.json"),
        ("mixed-caps-exceeded.json", "positive/s14-record-limit.json"),
        (
            "external-links-checked.json",
            "positive/external-links-checked-v2.json",
        ),
        ("partial-sources.json", "positive/partial-sources.json"),
    ] {
        let a = fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/s14-schema4-v1")
                .join(v1),
        )
        .unwrap();
        let b = fs::read(dir().join(v2)).unwrap();
        let (x, y) = (
            check_consistency(&a, dl()).unwrap(),
            check_consistency(&b, dl()).unwrap(),
        );
        assert_eq!(
            (x.rules_checked, x.omitted_records),
            (y.rules_checked, y.omitted_records),
            "{v2}"
        );
    }
    // the cap fixture really omits records, so the comparison is not vacuous
    let b = fs::read(dir().join("positive/s14-record-limit.json")).unwrap();
    assert!(check_consistency(&b, dl()).unwrap().omitted_records > 0);
}

/// v1 verdicts, stages and revision are unchanged on the v1 corpus.
#[test]
fn v1_corpus_still_admits_with_the_v1_revision() {
    let v1dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/s14-schema4-v1");
    for n in [
        "complete-clean.json",
        "partial-sources.json",
        "mixed-caps-exceeded.json",
        "exact-cap.json",
    ] {
        let a = admit(&fs::read(v1dir.join(n)).unwrap(), dl()).unwrap();
        assert_eq!(a.validator_revision, V1_REV, "{n}");
    }
}

/// The comparison series is new under v2: the key differs from the v1 twin
/// and the summary carries the v2 label.
#[test]
fn v2_summary_carries_the_label_and_a_new_comparison_key() {
    let v1dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/s14-schema4-v1");
    let a = admit(&fs::read(v1dir.join("complete-clean.json")).unwrap(), dl()).unwrap();
    let b = admit(
        &fs::read(dir().join("positive/complete-small.json")).unwrap(),
        dl(),
    )
    .unwrap();
    let (sa, sb): (Value, Value) = (
        serde_json::from_slice(&a.summary.canonical).unwrap(),
        serde_json::from_slice(&b.summary.canonical).unwrap(),
    );
    assert_eq!(sa["wire_contract_version"], "s14-wire-1");
    assert_eq!(sb["wire_contract_version"], "s14-wire-2");
    assert_ne!(sa["comparison_key"], sb["comparison_key"]);
    assert_eq!(sa["summary_version"], sb["summary_version"]);
}
