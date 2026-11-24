use crate::{MAX_POLICY_BYTES, MAX_REPORT_BYTES, raw};
use serde::{
    Deserialize,
    de::{self, SeqAccess, Visitor},
};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{fmt, time::Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InspectionError {
    ByteLimit,
    Utf8,
    Deadline,
    RawJson,
    Shape,
    Bounds,
    Url,
    Policy,
    UnsupportedSchema,
    SummaryTooLarge,
    SemanticValidationNotImplemented,
    SemanticMismatch,
}
impl fmt::Display for InspectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for InspectionError {}

/// Typed inspection evidence only. It cannot be supplied as a validation proof.
#[derive(Debug)]
pub struct InspectedCandidate {
    pub raw_sha256: String,
    pub raw_bytes: usize,
    pub page_count: usize,
    pub record_count: usize,
    pub coverage_count: usize,
}
/// Deliberately unconstructible outside this module; phase one never returns it.
pub struct ValidatedS14 {
    _private: (),
}
/// Admission stays fail-closed until independent full semantics are implemented.
///
/// # Errors
/// Returns inspection errors or `SemanticValidationNotImplemented`; never a proof.
pub fn validate_for_admission(
    raw: &[u8],
    deadline: Instant,
) -> Result<ValidatedS14, InspectionError> {
    inspect(raw, deadline)?;
    Err(InspectionError::SemanticValidationNotImplemented)
}

struct Bounded<T, const N: usize>(Vec<T>);
impl<'de, T: Deserialize<'de>, const N: usize> Deserialize<'de> for Bounded<T, N> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Values<T, const N: usize>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>, const N: usize> Visitor<'de> for Values<T, N> {
            type Value = Bounded<T, N>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "at most {N} values")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                loop {
                    if values.len() == N {
                        if seq.next_element::<de::IgnoredAny>()?.is_some() {
                            return Err(de::Error::custom("array bound"));
                        }
                        break;
                    }
                    let Some(value) = seq.next_element()? else {
                        break;
                    };
                    values.push(value);
                }
                Ok(Bounded(values))
            }
        }
        d.deserialize_seq(Values::<T, N>(std::marker::PhantomData))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Report<'a> {
    schema_version: u8,
    engine_version: String,
    ruleset_version: String,
    request: CollectionRequest,
    started_at: String,
    finished_at: String,
    #[serde(rename = "outcome")]
    _outcome: Outcome,
    #[serde(rename = "stop_reason")]
    _stop_reason: String,
    #[serde(rename = "coverage_complete")]
    _coverage_complete: bool,
    #[serde(borrow)]
    pages: Bounded<&'a RawValue, 40000>,
    #[serde(rename = "findings")]
    #[serde(borrow)]
    _findings: Bounded<&'a RawValue, 400_000>,
    #[serde(borrow)]
    policy_guidance: &'a RawValue,
    // Optional schema-4 coverage extension. It is parsed and verified separately;
    // its mere presence must not be read as an absence claim.
    #[serde(default)]
    #[serde(borrow)]
    #[serde(rename = "finding_coverage")]
    _finding_coverage: Option<&'a RawValue>,
}
#[derive(Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct CollectionRequest {
    request_id: String,
    website_id: String,
    binding_generation: u64,
    url: String,
    max_pages: u64,
    max_duration_seconds: u64,
    delay_ms: u64,
    check_external_links: bool,
    max_resources: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Completed,
    Partial,
    Cancelled,
    Failed,
}
#[derive(Deserialize, PartialEq, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    title_min: u64,
    title_max: u64,
    description_min: u64,
    description_max: u64,
    words_min: u64,
    links_max: u64,
    require_indexable: bool,
    forbid_redirects: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Guidance<'a> {
    version: String,
    config: Policy,
    #[serde(rename = "catalog")]
    #[serde(borrow)]
    _catalog: Bounded<&'a RawValue, 256>,
    #[serde(borrow)]
    candidate: Candidate<'a>,
    #[serde(borrow)]
    manifest: &'a RawValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Candidate<'a> {
    policy_canonical_json: String,
    policy_digest: String,
    #[serde(rename = "scope_digest")]
    _scope_digest: String,
    #[serde(rename = "manifest_digest")]
    _manifest_digest: String,
    observed_at: Interval,
    #[serde(borrow)]
    records: Bounded<PolicyRecord<'a>, 512>,
    #[serde(borrow)]
    coverage: &'a RawValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Interval {
    started_at: String,
    finished_at: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Category {
    Advisory,
    Observation,
    PolicyViolation,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Eligibility {
    Eligible,
    Ineligible,
    Unknown,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Attempt {
    Completed,
    NotAttempted,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RecordOutcome {
    Observed,
    AdvisoryTriggered,
    AdvisoryNotTriggered,
    Violation,
    NoViolation,
    Unknown,
    NotApplicable,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // These typed fields are not yet a semantic validator.
struct PolicyRecord<'a> {
    record_id: String,
    category: Category,
    rule_id: String,
    rule_version: String,
    entity_id: String,
    discriminator: String,
    eligibility: Eligibility,
    attempt: Attempt,
    outcome: RecordOutcome,
    actual: String,
    source_locator: Option<String>,
    expected: Option<String>,
    confidence: String,
    interval_ref: String,
    policy_ref: String,
    reason: Option<String>,
    context_locator: Option<String>,
    target_locator: Option<String>,
    #[serde(borrow)]
    observed_fact: Option<&'a RawValue>,
}
#[derive(Deserialize)]
struct PageView {
    url: String,
    is_resource: bool,
    links: Bounded<UrlView, MAX_REPORT_BYTES>,
    alternates: Bounded<UrlView, MAX_REPORT_BYTES>,
}
#[derive(Deserialize)]
struct UrlView {
    url: String,
}

fn parse<'a, T: Deserialize<'a>>(raw: &'a str) -> Result<T, InspectionError> {
    serde_json::from_str(raw).map_err(|_| InspectionError::Shape)
}
fn sha(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}
fn canonical(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(o) => {
            let mut keys: Vec<_> = o.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical(&o[k])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        serde_json::Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => value.to_string(),
    }
}
/// Inspect the provisional URL profile, without authorizing an audit.
///
/// # Errors
/// Rejects malformed/noncanonical URLs and the excluded credential/fragment/IDNA classes.
pub fn admitted_url(raw: &str) -> Result<url::Url, InspectionError> {
    let u = url::Url::parse(raw).map_err(|_| InspectionError::Url)?;
    if !matches!(u.scheme(), "http" | "https")
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || u.as_str() != raw
        || u.host_str()
            .is_some_and(|h| h.split('.').any(|k| k.starts_with("xn--")))
    {
        return Err(InspectionError::Url);
    }
    Ok(u)
}
fn uuid(raw: &str) -> bool {
    raw.len() == 36
        && raw.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn deadline_check(deadline: Instant) -> Result<(), InspectionError> {
    if Instant::now() >= deadline {
        Err(InspectionError::Deadline)
    } else {
        Ok(())
    }
}
/// Inspect bounded raw syntax and typed metadata only.
///
/// # Errors
/// Rejects syntax, bounds, URL/policy metadata errors or an expired inspection deadline.
/// A successful result does not certify source facts, coverage or registry semantics.
pub fn inspect(input: &[u8], deadline: Instant) -> Result<InspectedCandidate, InspectionError> {
    deadline_check(deadline)?;
    if input.len() > MAX_REPORT_BYTES {
        return Err(InspectionError::ByteLimit);
    }
    let text = std::str::from_utf8(input).map_err(|_| InspectionError::Utf8)?;
    raw::check(text, deadline).map_err(|e| {
        if e == "inspection deadline" {
            InspectionError::Deadline
        } else {
            InspectionError::RawJson
        }
    })?;
    let r: Report = parse(text)?;
    if r.schema_version != 4 || r.policy_guidance.get().len() > 1_048_576 {
        return Err(InspectionError::Bounds);
    }
    let q = &r.request;
    if !uuid(&q.request_id)
        || !uuid(&q.website_id)
        || q.binding_generation > 9_007_199_254_740_991
        || q.max_pages == 0
        || q.max_pages > 20000
        || q.max_resources > 20000
        || !(10..=7200).contains(&q.max_duration_seconds)
        || !(1000..=60000).contains(&q.delay_ms)
    {
        return Err(InspectionError::Bounds);
    }
    let seed = admitted_url(&q.url)?;
    if seed.port().is_some() || q.url.contains('?') {
        return Err(InspectionError::Url);
    }
    let g: Guidance = parse(r.policy_guidance.get())?;
    let p = &g.config;
    if g.version != "s14-wire-1"
        || [
            p.title_min,
            p.title_max,
            p.description_min,
            p.description_max,
            p.words_min,
            p.links_max,
        ]
        .iter()
        .any(|n| *n > 1_000_000)
        || p.title_min > p.title_max
        || p.description_min > p.description_max
        || g.candidate.policy_canonical_json.len() > MAX_POLICY_BYTES
        || g.manifest.get().len() > 262_144
        || g.candidate.coverage.get().len() > 262_144
    {
        return Err(InspectionError::Bounds);
    }
    let expected = serde_json::json!({"catalog_version":"s14-1","collection":{"check_external_links":q.check_external_links,"delay_ms":q.delay_ms,"max_duration_seconds":q.max_duration_seconds,"max_pages":q.max_pages,"max_resources":q.max_resources,"seed_url":q.url},"engine_version":r.engine_version,"policy":p,"ruleset_version":r.ruleset_version,"schema_version":4,"validator_version":"s14-wire-1","wire_contract_version":"s14-wire-1"});
    if g.candidate.policy_canonical_json != canonical(&expected)
        || g.candidate.policy_digest
            != format!(
                "sha256:{}",
                sha(g.candidate.policy_canonical_json.as_bytes())
            )
        || g.candidate.observed_at.started_at != r.started_at
        || g.candidate.observed_at.finished_at != r.finished_at
    {
        return Err(InspectionError::Policy);
    }
    let manifest: Bounded<&RawValue, 256> = parse(g.manifest.get())?;
    let coverage: Bounded<&RawValue, 256> = parse(g.candidate.coverage.get())?;
    if manifest.0.len() != 13
        || coverage.0.len() != 13
        || g.candidate
            .records
            .0
            .iter()
            .filter(|x| matches!(x.category, Category::Observation))
            .count()
            > 128
    {
        return Err(InspectionError::Bounds);
    }
    let mut resources = 0;
    for source in &r.pages.0 {
        deadline_check(deadline)?;
        let page: PageView = parse(source.get())?;
        admitted_url(&page.url)?;
        resources += usize::from(page.is_resource);
        for target in page.links.0.iter().chain(page.alternates.0.iter()) {
            admitted_url(&target.url)?;
        }
    }
    if resources > 20000 || r.pages.0.len() - resources > 20000 {
        return Err(InspectionError::Bounds);
    }
    deadline_check(deadline)?;
    Ok(InspectedCandidate {
        raw_sha256: sha(input),
        raw_bytes: input.len(),
        page_count: r.pages.0.len(),
        record_count: g.candidate.records.0.len(),
        coverage_count: coverage.0.len(),
    })
}
