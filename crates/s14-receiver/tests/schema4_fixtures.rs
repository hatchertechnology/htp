//! H1-final: the S2 schema-4 corpus (seosmith `s14/schema4-fixtures` c9ca3cd),
//! copied byte-identically, tied to S2's manifests by digest, and admitted.
//!
//! * `tests/fixtures/s14-schema4-v1/**` is S2's `fixtures/contracts/s14-schema4-v1/`.
//! * `tests/fixtures/s14-schema4-historical/**` holds the surviving historical
//!   positives (S2's pruned `s14-wire-1-candidate` and `s14-finding-coverage-v1`
//!   accept cases) with S2's manifests.
use htp_s14_receiver::{MAX_REPORT_BYTES, VALIDATOR_REVISION, admit, derive_saved_summary};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// Pinned digests of S2's manifests at c9ca3cd. A different manifest means the
/// corpus was regenerated: re-copy and re-pin deliberately.
const S2_MANIFEST_SHA256: &str = "c3c4e3c2ea14a88863f556e503a9b2f688ae75cb35ab14be35a624c03f9c0175";
const HISTORICAL_CANDIDATE_MANIFEST_SHA256: &str =
    "1648222711a6a305717dd40cf854a6726931c4abb94d6c9dcc3813f41a744d54";
const HISTORICAL_COVERAGE_MANIFEST_SHA256: &str =
    "926290f48b3ad00d676f4a3a2b5ef0d377274d8807a2a949d213717bd2134b0b";
/// 9 new schema-4 reports, 10 surviving candidate positives, 4 coverage cases.
const S2_FIXTURE_COUNT: usize = 9;
const HISTORICAL_CANDIDATE_ACCEPTS: usize = 10;
const HISTORICAL_COVERAGE_CASES: usize = 4;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}
fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    Sha256::digest(bytes)
        .iter()
        .fold(String::new(), |mut out, b| {
            write!(out, "{b:02x}").unwrap();
            out
        })
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(30)
}
fn read_checked(dir: &Path, path: &str, bytes: u64, sha256: &str) -> Vec<u8> {
    let data = fs::read(dir.join(path)).unwrap_or_else(|e| panic!("{path}: {e}"));
    assert_eq!(data.len() as u64, bytes, "{path}: byte length");
    assert_eq!(sha256_hex(&data), sha256, "{path}: sha256");
    data
}
fn manifest(dir: &Path, pinned: &str) -> Value {
    let raw = fs::read(dir.join("manifest.json")).unwrap();
    assert_eq!(
        sha256_hex(&raw),
        pinned,
        "{}: manifest digest",
        dir.display()
    );
    serde_json::from_slice(&raw).unwrap()
}

#[test]
fn s2_corpus_is_exactly_the_manifest_and_every_report_admits() {
    let dir = root().join("s14-schema4-v1");
    let m = manifest(&dir, S2_MANIFEST_SHA256);
    assert_eq!(
        m["max_report_bytes"].as_u64(),
        Some(MAX_REPORT_BYTES as u64)
    );
    let files = m["files"].as_array().unwrap();
    assert_eq!(files.len(), S2_FIXTURE_COUNT);

    // No stray report: the directory holds exactly the manifest, README and listed files.
    let mut on_disk: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    on_disk.sort();
    let mut expected: Vec<String> = files
        .iter()
        .map(|f| f["path"].as_str().unwrap().to_owned())
        .chain(["manifest.json".to_owned(), "README.md".to_owned()])
        .collect();
    expected.sort();
    assert_eq!(on_disk, expected);

    for f in files {
        let path = f["path"].as_str().unwrap();
        let raw = read_checked(
            &dir,
            path,
            f["bytes"].as_u64().unwrap(),
            f["sha256"].as_str().unwrap(),
        );
        let report: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(report["schema_version"], f["schema_version"], "{path}");
        assert_eq!(
            report["findings"].as_array().unwrap().len() as u64,
            f["findings"].as_u64().unwrap(),
            "{path}: findings"
        );
        assert_eq!(
            report["evidence_contract"]["truncated"].as_bool(),
            f["evidence_truncated"].as_bool(),
            "{path}: evidence truncated"
        );

        let admitted = admit(&raw, deadline()).unwrap_or_else(|e| panic!("{path}: {e}"));
        assert_eq!(admitted.validator_revision, VALIDATOR_REVISION, "{path}");
        let want = &f["admit"];
        assert_eq!(
            want["validator_revision"].as_str(),
            Some(VALIDATOR_REVISION),
            "{path}: manifest revision"
        );
        assert_eq!(
            want["summary_sha256"].as_str(),
            Some(admitted.summary.sha256.as_str()),
            "{path}: summary digest"
        );
        assert_eq!(
            want["summary_bytes"].as_u64(),
            Some(admitted.summary.canonical.len() as u64),
            "{path}: summary bytes"
        );
        assert_eq!(admitted.summary.source_bytes, raw.len() as u64, "{path}");
        let derived = derive_saved_summary(&raw, deadline()).unwrap();
        assert_eq!(admitted.summary.canonical, derived.canonical, "{path}");
    }
}

#[test]
fn exact_cap_is_the_cap_and_admits_within_the_deadline() {
    let dir = root().join("s14-schema4-v1");
    let raw = fs::read(dir.join("exact-cap.json")).unwrap();
    assert_eq!(raw.len(), MAX_REPORT_BYTES);
    let start = Instant::now();
    admit(&raw, start + Duration::from_secs(15)).expect("exact-cap admits under 15 s");
    assert!(start.elapsed() < Duration::from_secs(15));
    // One byte over the cap never reaches the deadline-bound stages.
    let mut over = raw.clone();
    over.push(b' ');
    assert!(admit(&over, deadline()).is_err());
}

#[test]
fn truncated_evidence_report_admits_and_the_flag_is_read_from_the_report() {
    let dir = root().join("s14-schema4-v1");
    let raw = fs::read(dir.join("mixed-caps-exceeded.json")).unwrap();
    let report: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(report["evidence_contract"]["truncated"], true);
    admit(&raw, deadline()).expect("truncated-evidence positive admits");
}

#[test]
fn surviving_historical_positives_match_s2_manifests_and_admit() {
    let hist = root().join("s14-schema4-historical");

    let dir = hist.join("s14-wire-1-candidate");
    let m = manifest(&dir, HISTORICAL_CANDIDATE_MANIFEST_SHA256);
    let mut accepts = 0;
    for f in m["files"].as_array().unwrap() {
        if f["expected_report_validation"] != "accept" {
            continue;
        }
        accepts += 1;
        let path = f["path"].as_str().unwrap();
        let raw = read_checked(
            &dir,
            path,
            f["bytes"].as_u64().unwrap(),
            f["sha256"].as_str().unwrap(),
        );
        admit(&raw, deadline()).unwrap_or_else(|e| panic!("{path}: {e}"));
    }
    assert_eq!(accepts, HISTORICAL_CANDIDATE_ACCEPTS);
    // The directory holds exactly the accepts plus the manifest.
    assert_eq!(
        fs::read_dir(&dir).unwrap().count(),
        HISTORICAL_CANDIDATE_ACCEPTS + 1
    );

    let dir = hist.join("s14-finding-coverage-v1");
    let m = manifest(&dir, HISTORICAL_COVERAGE_MANIFEST_SHA256);
    let cases = m["cases"].as_array().unwrap();
    assert_eq!(cases.len(), HISTORICAL_COVERAGE_CASES);
    for c in cases {
        let path = c["path"].as_str().unwrap();
        let raw = read_checked(
            &dir,
            path,
            c["bytes"].as_u64().unwrap(),
            c["sha256"].as_str().unwrap(),
        );
        admit(&raw, deadline()).unwrap_or_else(|e| panic!("{path}: {e}"));
    }
    assert_eq!(
        fs::read_dir(&dir).unwrap().count(),
        HISTORICAL_COVERAGE_CASES + 1
    );
}
