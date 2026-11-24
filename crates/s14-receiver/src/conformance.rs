//! Offline conformance against the retained producer successor S14 bundle.
//!
//! This module is a local, cooperative checker. It reads the producer fixture
//! tree by path, verifies the exact successor overlay against the pinned
//! original manifest, runs the independent receiver checks on the historical
//! positive reports, and compares the agreed URL and finding-coverage vectors.
//! It does not contact a service, issue admission authority, freeze a contract
//! or exercise the historical negative/reference fixtures.
//!
//! The producer's URL labels are historical expectations, not observations.
//! They are preserved verbatim in the returned evidence. A missing coverage
//! extension stays unknown, and a producer `partial` claim is never reported as
//! complete.
#![allow(clippy::module_name_repetitions)]

use crate::{
    Coverage, check_compatibility_findings, check_consistency, check_reconstructed_rules,
    check_scalar_advisories, check_source_bindings, finding_coverage_batch, inspect,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs,
    path::Path,
    time::{Duration, Instant},
};

/// SHA-256 of the retained successor manifest.
pub const SUCCESSOR_MANIFEST_SHA256: &str =
    "03c31ee3175c1dfc44ef74fdf2ba4fdafc1d7c2f5ed61495d80f9c196eba1a10";
/// SHA-256 of the original candidate manifest the successor overlays.
pub const ORIGINAL_MANIFEST_SHA256: &str =
    "2491686040291c370cae4c1aa19d536c22c3ce084b6257c1ce13eea0a33112ae";
/// SHA-256 of the agreed 42-case URL corpus (`url42.json`).
pub const URL_CORPUS_SHA256: &str =
    "65b7160adb3888ea4b8209354861ad281260f34d0186ecab2010abddad9ee975";
/// SHA-256 of the successor ingress vector file. Its labels are worker-only.
pub const INGRESS_VECTORS_SHA256: &str =
    "f2db22c0b8b832a0325acf75b9912632123d67d83e12e4fde5d90dd6aff0271c";
/// Exact number of files in the original and successor manifests.
pub const SUCCESSOR_FILE_COUNT: usize = 61;
/// Historical positive reports the receiver checks independently.
pub const ACCEPT_COUNT: usize = 27;
/// Historical reference-only entries preserved but not exercised.
pub const REFERENCE_COUNT: usize = 13;
/// Historical reject entries preserved but not exercised.
pub const REJECT_COUNT: usize = 20;
/// The one successor relabel: the URL-profile IDN report is explicitly rejected.
pub const REJECT_URL_PROFILE_IDN_COUNT: usize = 1;
/// Agreed URL corpus case count.
pub const URL_CASE_COUNT: usize = 42;
/// Pinned audit + policy rule catalogue size.
pub const CATALOGUE_RULE_COUNT: usize = 88;
/// SHA-256 of the pinned finding-coverage catalogue.
pub const CATALOGUE_SHA256: &str =
    "eaf832c1c0f087f46aec4d5fd62df35c43a52c2d773886912178a1ed12956ea8";

const ORIGINAL_MANIFEST_PATH: &str = "../s14-wire-1-candidate/manifest.json";
const ORIGINAL_FILE_PREFIX: &str = "../s14-wire-1-candidate/";
const URL_PROFILE: &str = "s14-url-candidate-1 revision 2";
const ORIGINAL_MANIFEST_COMMIT: &str = "67c57510d45bf3be68a14d00d44818377d57928f";
const URL_CORPUS_COMMIT: &str = "a7505a5231457379c93eedf555df90bc7fcc95b1";
const URL_NORMALIZATION_FILE: &str = "v4-candidate-url-normalization.json";

/// One URL corpus row with its preserved historical label and receiver decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UrlCase {
    /// Exact stored URL bytes from the corpus.
    pub stored: String,
    /// Producer historical label, preserved without reinterpretation.
    pub label: String,
    /// Receiver inspection decision.
    pub decision: UrlDecision,
}

/// Receiver inspection decision for a stored URL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UrlDecision {
    /// Parsed and inside the corpus seed scope.
    InScope,
    /// Parsed but outside the seed scope.
    OutOfScope,
    /// Rejected by the provisional URL profile.
    Reject,
}

impl UrlDecision {
    /// Stable label used in the conformance output.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InScope => "in_scope",
            Self::OutOfScope => "out_of_scope",
            Self::Reject => "reject",
        }
    }
}

/// Verified URL corpus metadata and rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UrlCorpus {
    /// Corpus version string.
    pub version: String,
    /// Corpus revision number.
    pub revision: u64,
    /// Corpus seed URL.
    pub seed: String,
    /// All 42 rows in file order.
    pub cases: Vec<UrlCase>,
}

/// One successor file with its exact bytes and preserved historical label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEvidence {
    /// Original manifest-relative file name.
    pub path: String,
    /// Exact retained byte length.
    pub bytes: usize,
    /// Exact retained SHA-256.
    pub sha256: String,
    /// Producer historical expectation, preserved verbatim.
    pub historical_label: String,
    /// Whether the receiver ran its semantic checks on this report.
    pub checked: bool,
}

/// One finding-coverage positive after independent verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoverageEvidence {
    /// Fixture file name.
    pub case: String,
    /// Exact retained byte length.
    pub bytes: usize,
    /// Exact retained SHA-256.
    pub sha256: String,
    /// Producer historical audit claim, preserved verbatim.
    pub historical_audit: String,
    /// Independently verified audit state.
    pub audit: Coverage,
    /// Independently verified complete rule count.
    pub complete: usize,
    /// Independently verified unknown rule count.
    pub unknown: usize,
    /// Retained findings for `missing_h1`.
    pub missing_h1_findings: usize,
    /// Verified coverage for `missing_h1`.
    pub missing_h1_coverage: Coverage,
    /// Rules with at least one retained finding, sorted.
    pub reported_rules: Vec<String>,
}

/// Complete offline conformance evidence for one successor bundle.
#[derive(Debug)]
pub struct ConformanceEvidence {
    /// Exact successor manifest digest.
    pub successor_manifest_sha256: String,
    /// Exact original manifest digest.
    pub original_manifest_sha256: String,
    /// Exact URL corpus digest.
    pub url_corpus_sha256: String,
    /// Exact ingress vector digest.
    pub ingress_vectors_sha256: String,
    /// All 61 successor files in original order.
    pub files: Vec<FileEvidence>,
    /// Verified URL corpus.
    pub url_corpus: UrlCorpus,
    /// Verified finding-coverage positives.
    pub coverage: Vec<CoverageEvidence>,
    /// Number of historical positive reports checked.
    pub accepted_reports_checked: usize,
}

impl ConformanceEvidence {
    /// Count files carrying an exact historical label.
    #[must_use]
    pub fn label_count(&self, label: &str) -> usize {
        self.files
            .iter()
            .filter(|file| file.historical_label == label)
            .count()
    }
}

/// A conformance mismatch with exact context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConformanceError {
    detail: String,
}

impl ConformanceError {
    fn new(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
        }
    }
}

impl fmt::Display for ConformanceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.detail.fmt(f)
    }
}

impl std::error::Error for ConformanceError {}

fn fail<T>(detail: impl Into<String>) -> Result<T, ConformanceError> {
    Err(ConformanceError::new(detail))
}

fn checked<T>(
    result: Result<T, crate::InspectionError>,
    context: &str,
) -> Result<T, ConformanceError> {
    result.map_err(|error| ConformanceError::new(format!("{context}: {error}")))
}

fn read(path: &Path) -> Result<Vec<u8>, ConformanceError> {
    fs::read(path)
        .map_err(|error| ConformanceError::new(format!("cannot read {}: {error}", path.display())))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn parse(bytes: &[u8], context: &str) -> Result<Value, ConformanceError> {
    serde_json::from_slice(bytes)
        .map_err(|error| ConformanceError::new(format!("{context}: invalid JSON: {error}")))
}

fn array<'a>(
    value: &'a Value,
    key: &str,
    context: &str,
) -> Result<&'a Vec<Value>, ConformanceError> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| ConformanceError::new(format!("{context}: missing array {key}")))
}

fn string<'a>(value: &'a Value, key: &str, context: &str) -> Result<&'a str, ConformanceError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ConformanceError::new(format!("{context}: missing string {key}")))
}

fn boolean(value: &Value, key: &str, context: &str) -> Result<bool, ConformanceError> {
    value
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| ConformanceError::new(format!("{context}: missing boolean {key}")))
}

fn integer(value: &Value, key: &str, context: &str) -> Result<u64, ConformanceError> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| ConformanceError::new(format!("{context}: missing integer {key}")))
}

/// Stable label for a verified coverage state.
#[must_use]
pub fn coverage_label(coverage: Coverage) -> &'static str {
    match coverage {
        Coverage::CompleteVerified => "complete",
        Coverage::UnknownPartial => "unknown",
    }
}

fn check_pin(actual: &str, expected: &str, context: &str) -> Result<(), ConformanceError> {
    if actual == expected {
        Ok(())
    } else {
        fail(format!("{context}: sha256 {actual} != pinned {expected}"))
    }
}

/// Verify the agreed 42-case URL corpus against the receiver URL profile.
///
/// The producer labels remain historical expectations. Each label is compared
/// with the receiver decision at the level the corpus agreed:
/// `in_scope`/`out_of_scope` choose the seed host and no explicit port;
/// both `reject` and `reject_noncanonical` require a profile rejection.
///
/// # Errors
/// Rejects an unsupported corpus version/revision, a malformed row, a missing
/// or duplicate-sized case list, or a receiver decision that contradicts the
/// historical label.
pub fn verify_url_corpus(input: &[u8]) -> Result<UrlCorpus, ConformanceError> {
    let value = parse(input, "URL corpus")?;
    let version = string(&value, "version", "URL corpus")?.to_owned();
    if version != "s14-url-candidate-1" {
        return fail(format!("URL corpus: unsupported version {version}"));
    }
    let revision = integer(&value, "revision", "URL corpus")?;
    if revision != 2 {
        return fail(format!("URL corpus: unsupported revision {revision}"));
    }
    let seed = string(&value, "seed", "URL corpus")?.to_owned();
    let seed_url = crate::admitted_url(&seed)
        .map_err(|error| ConformanceError::new(format!("URL corpus seed {seed}: {error}")))?;
    let rows = array(&value, "cases", "URL corpus")?;
    if rows.len() != URL_CASE_COUNT {
        return fail(format!(
            "URL corpus: {} cases, expected {URL_CASE_COUNT}",
            rows.len()
        ));
    }
    let mut cases = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let context = format!("URL corpus case {index}");
        let stored = string(row, "stored", &context)?.to_owned();
        let label = string(row, "expected", &context)?.to_owned();
        if !matches!(
            label.as_str(),
            "in_scope" | "out_of_scope" | "reject" | "reject_noncanonical"
        ) {
            return fail(format!("{context}: unknown historical label {label}"));
        }
        let decision = match crate::admitted_url(&stored) {
            Err(_) => UrlDecision::Reject,
            Ok(url) => {
                if url.host_str() == seed_url.host_str() && url.port().is_none() {
                    UrlDecision::InScope
                } else {
                    UrlDecision::OutOfScope
                }
            }
        };
        let agreed = match label.as_str() {
            "in_scope" => decision == UrlDecision::InScope,
            "out_of_scope" => decision == UrlDecision::OutOfScope,
            "reject" | "reject_noncanonical" => decision == UrlDecision::Reject,
            _ => false,
        };
        if !agreed {
            return fail(format!(
                "{context}: historical {label}, receiver {} for {stored}",
                decision.as_str()
            ));
        }
        cases.push(UrlCase {
            stored,
            label,
            decision,
        });
    }
    Ok(UrlCorpus {
        version,
        revision,
        seed,
        cases,
    })
}

fn coverage_checks<'a>(
    value: &'a Value,
    context: &str,
) -> Result<Vec<(&'a str, &'a str)>, ConformanceError> {
    let extension = value
        .get("finding_coverage")
        .ok_or_else(|| ConformanceError::new(format!("{context}: missing finding_coverage")))?;
    let rows = array(extension, "checks", context)?;
    rows.iter()
        .map(|row| {
            Ok((
                string(row, "rule_id", context)?,
                string(row, "status", context)?,
            ))
        })
        .collect()
}

/// Verify the four finding-coverage positive fixtures against producer claims.
///
/// Every rule state is compared, not just the aggregate counts. A producer
/// `partial` claim must remain partially unknown, and a retained finding stays
/// visible regardless of coverage.
///
/// # Errors
/// Rejects a changed fixture/catalogue digest, an incomplete catalogue, a
/// malformed claim, or any per-rule, audit or finding disagreement.
#[allow(clippy::too_many_lines)]
pub fn verify_coverage_positives(
    directory: &Path,
    timeout: Duration,
) -> Result<Vec<CoverageEvidence>, ConformanceError> {
    let manifest_bytes = read(&directory.join("manifest.json"))?;
    let manifest = parse(&manifest_bytes, "coverage manifest")?;
    let status = string(&manifest, "status", "coverage manifest")?;
    if status != "proposed-local-only-not-frozen" {
        return fail(format!("coverage manifest: unexpected status {status}"));
    }
    let catalogue_entry = manifest
        .get("catalogue")
        .ok_or_else(|| ConformanceError::new("coverage manifest: missing catalogue"))?;
    if string(catalogue_entry, "path", "coverage manifest")? != "catalogue-v1.json"
        || integer(catalogue_entry, "version", "coverage manifest")? != 1
        || usize::try_from(integer(catalogue_entry, "rules", "coverage manifest")?).ok()
            != Some(CATALOGUE_RULE_COUNT)
    {
        return fail("coverage manifest: catalogue metadata changed");
    }
    let catalogue_bytes = read(&directory.join("catalogue-v1.json"))?;
    check_pin(
        &sha256(&catalogue_bytes),
        CATALOGUE_SHA256,
        "coverage catalogue",
    )?;
    let catalogue = parse(&catalogue_bytes, "coverage catalogue")?;
    if integer(&catalogue, "version", "coverage catalogue")? != 1 {
        return fail("coverage catalogue: unsupported version");
    }
    let rules = array(&catalogue, "rules", "coverage catalogue")?;
    if rules.len() != CATALOGUE_RULE_COUNT {
        return fail(format!(
            "coverage catalogue: {} rules, expected {CATALOGUE_RULE_COUNT}",
            rules.len()
        ));
    }
    let mut previous: Option<&str> = None;
    for rule in rules {
        let rule = rule
            .as_str()
            .ok_or_else(|| ConformanceError::new("coverage catalogue: non-string rule"))?;
        if previous.is_some_and(|previous| previous >= rule) {
            return fail(format!(
                "coverage catalogue: rule {rule} is not unique and sorted"
            ));
        }
        previous = Some(rule);
    }
    let cases = array(&manifest, "cases", "coverage manifest")?;
    if cases.len() != 4 {
        return fail(format!(
            "coverage manifest: {} cases, expected 4",
            cases.len()
        ));
    }
    let mut evidence = Vec::with_capacity(cases.len());
    for entry in cases {
        let case = string(entry, "path", "coverage case")?;
        let context = format!("coverage case {case}");
        let bytes = read(&directory.join(case))?;
        let bytes_len = u64::try_from(bytes.len())
            .map_err(|_| ConformanceError::new(format!("{context}: byte length overflow")))?;
        if integer(entry, "bytes", &context)? != bytes_len {
            return fail(format!("{context}: byte length changed"));
        }
        let digest = sha256(&bytes);
        if string(entry, "sha256", &context)? != digest {
            return fail(format!("{context}: sha256 changed"));
        }
        let value = parse(&bytes, &context)?;
        let checks = coverage_checks(&value, &context)?;
        if checks.len() != rules.len() {
            return fail(format!(
                "{context}: {} checks, expected {}",
                checks.len(),
                rules.len()
            ));
        }
        let batch = checked(
            finding_coverage_batch(&bytes, Instant::now() + timeout),
            &context,
        )?;
        if batch.rules.len() != checks.len() {
            return fail(format!("{context}: receiver catalogue size changed"));
        }
        let mut complete = 0;
        for (coverage, check) in batch.rules.iter().zip(checks) {
            let (rule_id, claimed) = check;
            if coverage.rule != rule_id {
                return fail(format!(
                    "{context}: rule order {} != {rule_id}",
                    coverage.rule
                ));
            }
            let actual = coverage_label(coverage.coverage);
            if actual != claimed {
                return fail(format!(
                    "{context}: rule {rule_id} producer={claimed} receiver={actual}"
                ));
            }
            if coverage.coverage == Coverage::CompleteVerified {
                complete += 1;
            }
        }
        let unknown = batch.rules.len() - complete;
        let historical_audit = string(&value["finding_coverage"], "audit", &context)?;
        let claimed_audit = match historical_audit {
            "complete" => "complete",
            "partial" => "unknown",
            other => {
                return fail(format!("{context}: unknown audit claim {other}"));
            }
        };
        let actual_audit = coverage_label(batch.audit);
        if claimed_audit != actual_audit {
            return fail(format!(
                "{context}: audit producer={claimed_audit} receiver={actual_audit}"
            ));
        }
        let manifest_checks = entry
            .get("checks")
            .ok_or_else(|| ConformanceError::new(format!("{context}: missing checks counts")))?;
        if usize::try_from(integer(manifest_checks, "complete", &context)?).ok() != Some(complete)
            || usize::try_from(integer(manifest_checks, "unknown", &context)?).ok() != Some(unknown)
        {
            return fail(format!(
                "{context}: counts producer complete={} unknown={} receiver complete={complete} unknown={unknown}",
                integer(manifest_checks, "complete", &context)?,
                integer(manifest_checks, "unknown", &context)?,
            ));
        }
        let missing = batch
            .rules
            .iter()
            .find(|rule| rule.rule == "missing_h1")
            .ok_or_else(|| ConformanceError::new(format!("{context}: missing_h1 absent")))?;
        let expected_missing_finding = boolean(entry, "missing_h1_finding", &context)?;
        if (missing.reported_findings > 0) != expected_missing_finding {
            return fail(format!("{context}: missing_h1 finding visibility changed"));
        }
        let expected_missing_check = string(entry, "missing_h1_check", &context)?;
        if coverage_label(missing.coverage) != expected_missing_check {
            return fail(format!(
                "{context}: missing_h1 producer={expected_missing_check} receiver={}",
                coverage_label(missing.coverage)
            ));
        }
        let mut reported = batch
            .rules
            .iter()
            .filter(|rule| rule.reported_findings > 0)
            .map(|rule| rule.rule.clone())
            .collect::<Vec<_>>();
        reported.sort_unstable();
        let mut expected_rules = array(entry, "expected_findings", &context)?
            .iter()
            .map(|rule| {
                rule.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| ConformanceError::new(format!("{context}: non-string finding")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        expected_rules.sort_unstable();
        if reported != expected_rules {
            return fail(format!(
                "{context}: reported rules {reported:?} != expected {expected_rules:?}"
            ));
        }
        evidence.push(CoverageEvidence {
            case: case.to_owned(),
            bytes: bytes.len(),
            sha256: digest,
            historical_audit: historical_audit.to_owned(),
            audit: batch.audit,
            complete,
            unknown,
            missing_h1_findings: missing.reported_findings,
            missing_h1_coverage: missing.coverage,
            reported_rules: reported,
        });
    }
    Ok(evidence)
}

fn overlay_label_agrees(name: &str, original: &str, successor: &str) -> bool {
    if name == URL_NORMALIZATION_FILE {
        original == "accept" && successor == "reject_url_profile_idn"
    } else {
        original == successor
    }
}

fn verify_manifest_entry(
    entry: &Value,
    directory: &Path,
    context: &str,
) -> Result<(String, Vec<u8>), ConformanceError> {
    let path = string(entry, "path", context)?.to_owned();
    let bytes = read(&directory.join(&path))?;
    let length = u64::try_from(bytes.len())
        .map_err(|_| ConformanceError::new(format!("{context}: byte length overflow")))?;
    if integer(entry, "bytes", context)? != length {
        return fail(format!("{context}: byte length changed for {path}"));
    }
    if string(entry, "sha256", context)? != sha256(&bytes) {
        return fail(format!("{context}: sha256 changed for {path}"));
    }
    Ok((path, bytes))
}

#[allow(clippy::too_many_lines)]
fn verify_reports(
    files: &[Value],
    original: &Path,
    timeout: Duration,
) -> Result<Vec<FileEvidence>, ConformanceError> {
    let mut evidence = Vec::with_capacity(files.len());
    let mut accepted = 0;
    for entry in files {
        let relative = string(entry, "path", "successor file")?;
        let name = relative.strip_prefix(ORIGINAL_FILE_PREFIX).ok_or_else(|| {
            ConformanceError::new(format!(
                "successor file {relative} is not under {ORIGINAL_FILE_PREFIX}"
            ))
        })?;
        let bytes = read(&original.join(name))?;
        let length = u64::try_from(bytes.len())
            .map_err(|_| ConformanceError::new(format!("{name}: byte length overflow")))?;
        let digest = sha256(&bytes);
        if integer(entry, "bytes", name)? != length || string(entry, "sha256", name)? != digest {
            return fail(format!("{name}: successor bytes changed"));
        }
        let label = string(entry, "semantic_expectation", name)?.to_owned();
        let is_checked = label == "accept";
        if is_checked {
            let deadline = Instant::now() + timeout;
            checked(inspect(&bytes, deadline), name)?;
            checked(check_source_bindings(&bytes, deadline), name)?;
            checked(check_consistency(&bytes, deadline), name)?;
            checked(check_reconstructed_rules(&bytes, deadline), name)?;
            checked(check_scalar_advisories(&bytes, deadline), name)?;
            checked(check_compatibility_findings(&bytes, deadline), name)?;
            let batch = checked(finding_coverage_batch(&bytes, deadline), name)?;
            if batch.audit != Coverage::UnknownPartial
                || batch
                    .rules
                    .iter()
                    .any(|rule| rule.coverage != Coverage::UnknownPartial)
            {
                return fail(format!(
                    "{name}: a report without a coverage extension must stay unknown"
                ));
            }
            accepted += 1;
        }
        evidence.push(FileEvidence {
            path: name.to_owned(),
            bytes: bytes.len(),
            sha256: digest,
            historical_label: label,
            checked: is_checked,
        });
    }
    if accepted != ACCEPT_COUNT {
        return fail(format!(
            "successor bundle: {accepted} checked positives, expected {ACCEPT_COUNT}"
        ));
    }
    Ok(evidence)
}

/// Verify one producer `fixtures/contracts` tree offline.
///
/// The tree must contain the successor overlay (`s14-worker-slice-r2`), the
/// pinned original manifest and reports (`s14-wire-1-candidate`) and the
/// finding-coverage positives (`s14-finding-coverage-v1`).
///
/// # Errors
/// Rejects a missing file, a changed pin, an overlay that is not the exact
/// historical original plus the single agreed IDN relabel, a changed URL or
/// coverage vector, a receiver check failure, or any count/label disagreement.
#[allow(clippy::too_many_lines)]
pub fn verify_successor_contracts(
    contracts: &Path,
    timeout: Duration,
) -> Result<ConformanceEvidence, ConformanceError> {
    let successor = contracts.join("s14-worker-slice-r2");
    let original = contracts.join("s14-wire-1-candidate");
    let coverage = contracts.join("s14-finding-coverage-v1");

    let successor_bytes = read(&successor.join("manifest.json"))?;
    let successor_sha256 = sha256(&successor_bytes);
    check_pin(
        &successor_sha256,
        SUCCESSOR_MANIFEST_SHA256,
        "successor manifest",
    )?;
    let manifest = parse(&successor_bytes, "successor manifest")?;
    let status = string(&manifest, "status", "successor manifest")?;
    if status != "proposed-local-only-not-frozen" {
        return fail(format!("successor manifest: unexpected status {status}"));
    }
    let original_entry = manifest
        .get("original_manifest")
        .ok_or_else(|| ConformanceError::new("successor manifest: missing original_manifest"))?;
    if string(original_entry, "path", "original manifest")? != ORIGINAL_MANIFEST_PATH {
        return fail("successor manifest: original manifest path changed");
    }
    let original_bytes = read(&original.join("manifest.json"))?;
    let original_sha256 = sha256(&original_bytes);
    check_pin(
        &original_sha256,
        ORIGINAL_MANIFEST_SHA256,
        "original manifest",
    )?;
    check_pin(
        string(original_entry, "sha256", "original manifest")?,
        &original_sha256,
        "successor original_manifest",
    )?;
    let provenance = manifest
        .get("provenance")
        .ok_or_else(|| ConformanceError::new("successor manifest: missing provenance"))?;
    if string(provenance, "url_profile", "provenance")? != URL_PROFILE
        || string(provenance, "original_manifest_commit", "provenance")? != ORIGINAL_MANIFEST_COMMIT
        || string(provenance, "url_corpus_commit", "provenance")? != URL_CORPUS_COMMIT
    {
        return fail("successor manifest: provenance changed");
    }

    let (url_path, url_bytes) = verify_manifest_entry(
        manifest
            .get("url_corpus")
            .ok_or_else(|| ConformanceError::new("successor manifest: missing url_corpus"))?,
        &successor,
        "url corpus",
    )?;
    let url_sha256 = sha256(&url_bytes);
    check_pin(&url_sha256, URL_CORPUS_SHA256, "url corpus")?;
    if url_path != "url42.json" {
        return fail(format!(
            "successor manifest: unexpected URL corpus {url_path}"
        ));
    }
    let url_corpus = verify_url_corpus(&url_bytes)?;

    let (ingress_path, ingress_bytes) = verify_manifest_entry(
        manifest
            .get("ingress_vectors")
            .ok_or_else(|| ConformanceError::new("successor manifest: missing ingress_vectors"))?,
        &successor,
        "ingress vectors",
    )?;
    let ingress_sha256 = sha256(&ingress_bytes);
    check_pin(&ingress_sha256, INGRESS_VECTORS_SHA256, "ingress vectors")?;
    if ingress_path != "ingress.json" {
        return fail(format!(
            "successor manifest: unexpected ingress vectors {ingress_path}"
        ));
    }

    let original_manifest = parse(&original_bytes, "original manifest")?;
    let original_files = array(&original_manifest, "files", "original manifest")?;
    if original_files.len() != SUCCESSOR_FILE_COUNT {
        return fail(format!(
            "original manifest: {} files, expected {SUCCESSOR_FILE_COUNT}",
            original_files.len()
        ));
    }
    let mut original_by_name = BTreeMap::new();
    let mut original_order = Vec::with_capacity(original_files.len());
    for entry in original_files {
        let name = string(entry, "path", "original manifest")?;
        if name.contains('/') {
            return fail(format!("original manifest: nested path {name}"));
        }
        if original_by_name.insert(name.to_owned(), entry).is_some() {
            return fail(format!("original manifest: duplicate file {name}"));
        }
        original_order.push(name.to_owned());
    }

    let successor_files = array(&manifest, "files", "successor manifest")?;
    if successor_files.len() != SUCCESSOR_FILE_COUNT {
        return fail(format!(
            "successor manifest: {} files, expected {SUCCESSOR_FILE_COUNT}",
            successor_files.len()
        ));
    }
    let mut successor_order = Vec::with_capacity(successor_files.len());
    let mut files = Vec::with_capacity(successor_files.len());
    for entry in successor_files {
        let relative = string(entry, "path", "successor manifest")?;
        let name = relative.strip_prefix(ORIGINAL_FILE_PREFIX).ok_or_else(|| {
            ConformanceError::new(format!(
                "successor manifest: {relative} is not under {ORIGINAL_FILE_PREFIX}"
            ))
        })?;
        let original_entry = original_by_name.get(name).ok_or_else(|| {
            ConformanceError::new(format!(
                "successor manifest: {name} is not in the original manifest"
            ))
        })?;
        successor_order.push(name.to_owned());
        let original_label = string(original_entry, "expected_report_validation", name)?;
        let label = string(entry, "semantic_expectation", name)?;
        if !overlay_label_agrees(name, original_label, label) {
            return fail(format!(
                "successor manifest: {name} historical {original_label} relabeled {label}"
            ));
        }
        if integer(entry, "bytes", name)? != integer(original_entry, "bytes", name)?
            || string(entry, "sha256", name)? != string(original_entry, "sha256", name)?
        {
            return fail(format!("successor manifest: {name} bytes or hash changed"));
        }
        let bytes = read(&original.join(name))?;
        let length = u64::try_from(bytes.len())
            .map_err(|_| ConformanceError::new(format!("{name}: byte length overflow")))?;
        if length != integer(original_entry, "bytes", name)?
            || sha256(&bytes) != string(original_entry, "sha256", name)?
        {
            return fail(format!("original file {name}: pinned bytes changed"));
        }
        files.push(FileEvidence {
            path: name.to_owned(),
            bytes: bytes.len(),
            sha256: sha256(&bytes),
            historical_label: label.to_owned(),
            checked: false,
        });
    }
    if original_order != successor_order {
        return fail("successor manifest: file order differs from the original");
    }

    let checked_files = verify_reports(successor_files, &original, timeout)?;
    for (file, checked_file) in files.iter_mut().zip(checked_files) {
        if file.path != checked_file.path
            || file.bytes != checked_file.bytes
            || file.sha256 != checked_file.sha256
            || file.historical_label != checked_file.historical_label
        {
            return fail("successor manifest: report evidence changed during checking");
        }
        file.checked = checked_file.checked;
    }
    let labels = files
        .iter()
        .map(|file| file.historical_label.clone())
        .collect::<BTreeSet<_>>();
    for (label, expected) in [
        ("accept", ACCEPT_COUNT),
        ("reference", REFERENCE_COUNT),
        ("reject", REJECT_COUNT),
        ("reject_url_profile_idn", REJECT_URL_PROFILE_IDN_COUNT),
    ] {
        let actual = files
            .iter()
            .filter(|file| file.historical_label == label)
            .count();
        if actual != expected {
            return fail(format!(
                "successor bundle: {actual} {label} entries, expected {expected}"
            ));
        }
    }
    if labels.len() != 4 {
        return fail(format!(
            "successor bundle: unexpected historical labels {labels:?}"
        ));
    }
    let coverage_evidence = verify_coverage_positives(&coverage, timeout)?;

    Ok(ConformanceEvidence {
        successor_manifest_sha256: successor_sha256,
        original_manifest_sha256: original_sha256,
        url_corpus_sha256: url_sha256,
        ingress_vectors_sha256: ingress_sha256,
        files,
        url_corpus,
        coverage: coverage_evidence,
        accepted_reports_checked: ACCEPT_COUNT,
    })
}
