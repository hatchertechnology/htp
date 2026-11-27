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

/// sha256 of the committed `manifest.json`, i.e. of the `SEOsmith` 8b-4 manifest at
/// the source commit recorded in `SOURCE`. Changing the manifest means re-copying
/// the whole 8b-4 set, never editing it here.
const MANIFEST_SHA256: &str = "8cf09c2ab2d3534590061a7c5a3128753615279958ad5122fc0173d06229448b";
const SOURCE_COMMIT: &str = "ad1e8612268fcaae92d618cb867fdeea10552094";

fn manifest() -> Value {
    serde_json::from_slice(&fs::read(dir().join("manifest.json")).unwrap()).unwrap()
}

/// The fixtures are byte-copies of `SEOsmith` 8b-4 `fixtures/wire2/**`: the manifest is
/// pinned, every file's size and sha256 equal the manifest, and no file is orphaned.
#[test]
fn committed_fixtures_are_the_pinned_8b4_set() {
    let raw = fs::read(dir().join("manifest.json")).unwrap();
    assert_eq!(sha_hex(&raw), MANIFEST_SHA256, "manifest.json changed");
    let source = fs::read_to_string(dir().join("SOURCE")).unwrap();
    assert!(source.contains(SOURCE_COMMIT), "SOURCE: {source}");
    let m = manifest();
    assert_eq!(m["manifest_version"], 1);
    assert_eq!(m["v2_revision"], V2_REV);
    assert_eq!(m["v1_revision"], V1_REV);
    assert_eq!(m["max_report_bytes"], 4_952_756);
    let files = m["files"].as_array().unwrap();
    let positives = files
        .iter()
        .filter(|f| f["expect"]["admit"] == true)
        .count();
    assert_eq!((positives, files.len() - positives), (14, 49));
    let mut listed = Vec::new();
    for f in files {
        let path = f["path"].as_str().unwrap();
        let b = fs::read(dir().join(path)).unwrap_or_else(|e| panic!("{path}: {e}"));
        assert_eq!(b.len() as u64, f["bytes"].as_u64().unwrap(), "{path} bytes");
        assert_eq!(sha_hex(&b), f["sha256"].as_str().unwrap(), "{path} sha256");
        listed.push(path.to_owned());
    }
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
    assert_eq!(found, listed, "orphan or missing fixture files");
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
    // exact-cap-v2 is the largest committed fixture (== max_report_bytes); the
    // record-limit one is kept as the heaviest per-record workload.
    let largest = manifest()["max_report_bytes"].as_u64().unwrap();
    for n in [
        "positive/exact-cap-v2.json",
        "positive/s14-record-limit.json",
    ] {
        let b = fs::read(dir().join(n)).unwrap();
        if n.contains("exact-cap") {
            assert_eq!(b.len() as u64, largest, "{n} is the largest fixture");
        }
        let t = Instant::now();
        admit(&b, dl()).unwrap();
        assert!(
            t.elapsed() < Duration::from_secs(10),
            "{n}: {:?}",
            t.elapsed()
        );
    }
}

#[test]
fn admit_stage_and_error_match_the_manifest_for_every_fixture() {
    let manifest = manifest();
    let files = manifest["files"].as_array().unwrap();
    let (mut accepted, mut rejected) = (0, 0);
    let mut mismatches = Vec::new();
    for f in files {
        let path = f["path"].as_str().unwrap();
        let bytes = fs::read(dir().join(path)).unwrap();
        assert_eq!(sha_hex(&bytes), f["sha256"].as_str().unwrap(), "{path}");
        let got = admit(&bytes, dl());
        let expect = &f["expect"];
        // the `admit` record (written by the verify script against this receiver)
        // must say the same as `expect`
        let rec = &f["admit"];
        assert_eq!(rec["admit"], expect["admit"], "{path} admit record");
        for k in ["validator_revision", "stage", "error"] {
            assert_eq!(rec.get(k), expect.get(k), "{path} admit.{k}");
        }
        if expect["admit"] == true {
            let a = got.unwrap_or_else(|e| panic!("{path}: unexpected rejection {e}"));
            assert_eq!(
                a.validator_revision,
                expect["validator_revision"].as_str().unwrap(),
                "{path}"
            );
            assert_eq!(
                format!("sha256:{}", sha_hex(&a.summary.canonical)),
                rec["summary_sha256"].as_str().unwrap(),
                "{path} summary sha256"
            );
            assert_eq!(
                a.summary.canonical.len() as u64,
                rec["summary_bytes"].as_u64().unwrap(),
                "{path} summary bytes"
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
            mismatches.extend(check_parity(path, &bytes, expect));
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
    assert_eq!((accepted, rejected), (14, 49));
}

/// Review R2-1: `check_*` parity on a rejected fixture (section 5/7: "admit and every
/// check_* must agree on stage and error").
/// * `inspection`: every `check_*` re-runs inspection, so each returns the expected error.
/// * `summary`: `check_scalar_advisories`, `check_reconstructed_rules` and
///   `finding_coverage_batch` return the expected error; `check_source_bindings` and
///   `check_consistency` may accept (bindings do not read the manifest counts and
///   digests; consistency does not read digests) but never return another error.
/// * `population`: no `check_*` covers the population stage (`findings_match` runs
///   only inside `admit`), so all five accept. This pins that honest gap.
fn check_parity(path: &str, b: &[u8], expect: &Value) -> Vec<String> {
    let stage = expect["stage"].as_str().unwrap();
    let want = expect["error"].as_str().unwrap();
    let results: [(&str, Result<(), InspectionError>); 5] = [
        ("check_source_bindings", check_source_bindings(b, dl())),
        ("check_consistency", check_consistency(b, dl()).map(drop)),
        ("check_scalar_advisories", check_scalar_advisories(b, dl())),
        (
            "check_reconstructed_rules",
            check_reconstructed_rules(b, dl()),
        ),
        (
            "finding_coverage_batch",
            finding_coverage_batch(b, dl()).map(drop),
        ),
    ];
    let mut bad = Vec::new();
    for (n, r) in results {
        let got = r.map_or_else(name, |()| "accepted".to_owned());
        let may_accept = match stage {
            "inspection" => false,
            "summary" => matches!(n, "check_source_bindings" | "check_consistency"),
            "population" => true,
            other => panic!("{path}: unexpected stage {other}"),
        };
        let ok = if stage == "population" {
            got == "accepted"
        } else {
            got == want || (may_accept && got == "accepted")
        };
        if !ok {
            bad.push(format!(
                "{path}: {n} returned `{got}`, stage {stage} want `{want}`"
            ));
        }
    }
    bad
}

/// RECEIVER-ONLY cases the 8b-4 set does not cover (w1c-8b4 finding 3): the producer
/// writes compact JSON only, so raw-whitespace boundary positives, the facts depth-4
/// boundary and the locator-on-linkless-page negatives cannot come from it. They are
/// generated in memory by `wire2_common::cases()` (no committed files) and asserted
/// here; `check_*` parity runs on each.
const RECEIVER_ONLY: [(&str, usize, &str); 5] = [
    (
        "positive/families-raw-over-cap-compact-ok.json",
        858_146,
        "1f6e6a8ceb362ac050ce4def0a2dc1f5815e88abd4aaa43a6ef7dfe36b3b7d17",
    ),
    (
        "positive/manifest-raw-over-16384-compact-ok.json",
        75_146,
        "81657f91046b957648c3d2351a1c58769f5329618808574f617a70139313f226",
    ),
    (
        "positive/families-facts-depth-4.json",
        58_157,
        "08e8aa50443bf31d8447615d691a8fd09633bff02a110dc9f62c5da13483fa82",
    ),
    (
        "negative/families-link-locator-on-linkless-page.json",
        416_078,
        "e7a179ecad07f01236b935686b491a1affc0ad704963b237ac9724fb250cc248",
    ),
    (
        "negative/families-relationship-locator-on-empty-page.json",
        416_086,
        "6191fd48e489defed9ca55f702a809f07d6316893e296d2cf56b230ebe840408",
    ),
];

#[test]
fn receiver_only_cases_keep_the_coverage_the_8b4_set_lacks() {
    let all = cases();
    let manifest_paths: Vec<String> = manifest()["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_owned())
        .collect();
    let v1dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/s14-schema4-v1");
    let mut seen = 0;
    for (want, want_len, want_sha) in RECEIVER_ONLY {
        let c = all
            .iter()
            .find(|c| c.path == want)
            .unwrap_or_else(|| panic!("generator lost {want}"));
        assert!(
            !manifest_paths.iter().any(|p| p == want),
            "{want} now in 8b-4: drop it here"
        );
        seen += 1;
        assert_eq!(c.bytes.len(), want_len, "{want} bytes");
        assert_eq!(sha_hex(&c.bytes), want_sha, "{want} sha256");
        let got = admit(&c.bytes, dl());
        match c.expect {
            None => {
                let a = got.unwrap_or_else(|e| panic!("{want}: rejected {e}"));
                assert_eq!(a.validator_revision, V2_REV, "{want}");
                check_source_bindings(&c.bytes, dl()).unwrap();
                check_scalar_advisories(&c.bytes, dl()).unwrap();
                check_reconstructed_rules(&c.bytes, dl()).unwrap();
                finding_coverage_batch(&c.bytes, dl()).unwrap();
                // check_consistency under v2 equals its v1 twin (the base is a v1 fixture)
                let twin = fs::read(v1dir.join(c.base)).unwrap();
                let (x, y) = (
                    check_consistency(&twin, dl()).unwrap(),
                    check_consistency(&c.bytes, dl()).unwrap(),
                );
                assert_eq!(
                    (x.rules_checked, x.omitted_records),
                    (y.rules_checked, y.omitted_records),
                    "{want} vs {}",
                    c.base
                );
            }
            Some((stage, error)) => {
                let e = got.expect_err(want);
                assert_eq!(
                    (e.stage.as_str(), name(e.error)),
                    (stage, error.to_owned()),
                    "{want}"
                );
                let expect = serde_json::json!({"stage": stage, "error": error});
                let bad = check_parity(want, &c.bytes, &expect);
                assert!(bad.is_empty(), "{}", bad.join("\n"));
            }
        }
    }
    assert_eq!(seen, 5);
    // the raw-whitespace positives really are over their raw caps (not vacuous)
    let raw = |n: &str| all.iter().find(|c| c.path == n).unwrap().bytes.len();
    assert!(raw(RECEIVER_ONLY[0].0) > 786_432 && raw(RECEIVER_ONLY[1].0) > 16_384);
}

/// Review R2-1 (restored, F1/B1): `check_consistency` under v2 equals its v1 twin for
/// every generated v2 positive. The committed 8b-4 manifest `base` is free text, so the
/// twins come from the in-test generator (`wire2_common::cases()`), which still builds
/// each positive from a real v1 base fixture. The 14 committed positives have no v1
/// twin (8b-4 does not produce them); see `committed_positives_consistency_matches_own_coverage_rows`.
#[test]
fn check_consistency_v2_matches_the_v1_twin() {
    let v1dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/s14-schema4-v1");
    let (mut twins, mut omitting) = (0, 0);
    for c in cases().iter().filter(|c| c.expect.is_none()) {
        let a = fs::read(v1dir.join(c.base)).unwrap();
        let (x, y) = (
            check_consistency(&a, dl()).unwrap(),
            check_consistency(&c.bytes, dl()).unwrap(),
        );
        assert_eq!(
            (x.rules_checked, x.omitted_records),
            (y.rules_checked, y.omitted_records),
            "{} vs {}",
            c.path,
            c.base
        );
        omitting += usize::from(y.omitted_records > 0);
        twins += 1;
    }
    assert!(twins >= 15, "{twins}");
    // the record-limit twin really omits records, so the comparison is not vacuous
    assert!(omitting > 0);
}

/// Per committed 8b-4 positive: `(file, rules_checked, omitted_records)` pinned.
const COMMITTED_COVERAGE: [(&str, usize, u64); 14] = [
    ("capture-omissions", 13, 0),
    ("complete-small", 13, 0),
    ("entities-1024", 13, 7965),
    ("exact-cap-v2", 13, 148),
    ("external-links-checked-v2", 13, 0),
    ("family-byte-budget", 13, 1138),
    ("family-item-limit", 13, 1138),
    ("locators-v2", 13, 0),
    ("manifest-scale", 13, 14139),
    ("partial-sources", 13, 0),
    ("report-budget-degraded", 13, 1138),
    ("s14-record-limit", 13, 1688),
    ("unbound-url-item", 13, 0),
    ("wire2-limits", 13, 1138),
];

/// H-B1 (coordinator decision, not owner retirement): `SEOsmith` 8b-4 does not produce
/// v1 twins for the 14 committed positives (manifest `base` is free text), so a v1
/// twin comparison is impossible for them. Coverage is instead (1) the generated-positive
/// twin check above and (2) this per-file check: `check_consistency`'s `rules_checked`
/// and `omitted_records` equal values derived independently from the file's own
/// `policy_guidance.candidate.coverage` rows (row count; sum of `candidates - emitted`,
/// which must equal each row's `omitted`), and both equal the pinned table.
#[test]
fn committed_positives_consistency_matches_own_coverage_rows() {
    let man = manifest();
    let mut seen = Vec::new();
    for f in man["files"].as_array().unwrap() {
        if f["expect"]["admit"] != true {
            continue;
        }
        let path = f["path"].as_str().unwrap();
        let stem = path
            .strip_prefix("positive/")
            .and_then(|n| n.strip_suffix(".json"))
            .unwrap();
        let bytes = fs::read(dir().join(path)).unwrap();
        let doc: Value = serde_json::from_slice(&bytes).unwrap();
        let rows = doc["policy_guidance"]["candidate"]["coverage"]
            .as_array()
            .unwrap();
        let mut omitted = 0u64;
        for r in rows {
            let (cand, emit, omit) = (
                r["candidates"].as_u64().unwrap(),
                r["emitted"].as_u64().unwrap(),
                r["omitted"].as_u64().unwrap(),
            );
            assert_eq!(cand - emit, omit, "{stem} {}", r["rule_id"]);
            omitted += omit;
        }
        let got = check_consistency(&bytes, dl()).unwrap();
        assert_eq!(
            (got.rules_checked, got.omitted_records),
            (rows.len(), omitted),
            "{stem}: check_consistency vs own coverage rows"
        );
        let pin = COMMITTED_COVERAGE
            .iter()
            .find(|p| p.0 == stem)
            .unwrap_or_else(|| panic!("{stem}: not pinned"));
        assert_eq!((pin.1, pin.2), (rows.len(), omitted), "{stem}: pin");
        seen.push(stem.to_owned());
    }
    assert_eq!(seen.len(), COMMITTED_COVERAGE.len());
    assert!(COMMITTED_COVERAGE.iter().any(|p| p.2 > 0));
}

/// F1 (review-8c1-h): a v1 report whose page carries a non-array `relationships`
/// member keeps its origin/main verdict: `summary`/`Shape` (the member is ignored at
/// inspection under v1). It must not move to `inspection`.
#[test]
fn v1_non_array_relationships_keeps_its_summary_stage() {
    let v1dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/s14-schema4-v1");
    let raw = fs::read(v1dir.join("complete-clean.json")).unwrap();
    for (label, value, stage, error) in [
        ("array", serde_json::json!([]), None, None),
        ("null", Value::Null, Some("summary"), Some("Shape")),
        (
            "number",
            serde_json::json!(5),
            Some("summary"),
            Some("Shape"),
        ),
        (
            "string",
            serde_json::json!("x"),
            Some("summary"),
            Some("Shape"),
        ),
        (
            "object",
            serde_json::json!({}),
            Some("summary"),
            Some("Shape"),
        ),
    ] {
        let mut v: Value = serde_json::from_slice(&raw).unwrap();
        v["pages"][0]["relationships"] = value;
        let got = admit(&serde_json::to_vec(&v).unwrap(), dl());
        match (got, stage) {
            (Ok(a), None) => assert_eq!(a.validator_revision, V1_REV, "{label}"),
            (Err(e), Some(s)) => assert_eq!(
                (e.stage.as_str(), name(e.error)),
                (s, error.unwrap().to_owned()),
                "{label}"
            ),
            (g, _) => panic!("{label}: {:?}", g.map(|a| a.validator_revision)),
        }
    }
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
