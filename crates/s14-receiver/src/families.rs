//! Wire-2 `evidence_families` (families-v1) validation, from the raw bytes.
//!
//! HTP validates the bounded shape and the bindings; it does not recompute the
//! families (they are producer-asserted, excluded from population equality). The
//! member is required and an object under `s14-wire-2`, every level rejects
//! unknown keys, and an explicit `null` is never read as absent.
//!
//! Error mapping (the parity pair compares these names):
//! * `Bounds`: raw size > 786,432 B; section/item/summary/facts byte or depth or
//!   count bounds (§3.2-6).
//! * `UnsupportedSchema`: `version` is an integer other than 1.
//! * `Shape`: everything else (absent, `null`, not an object, unknown or missing
//!   keys, wrong types, any other §3.2 invariant, table mismatch).
use crate::InspectionError as E;
use serde::Deserialize;
use serde_json::{Map, Value, value::RawValue};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Instant};

pub(crate) const MAX_FAMILIES_BYTES: usize = 786_432;
const MAX_FACTS_BYTES: usize = 4096;
const MAX_FACTS_DEPTH: usize = 4;
const MAX_STRING: usize = 2048;
const MAX_SUMMARY_BYTES: usize = 8192;

/// §3.3 per-family caps, in the §3.1 key order.
const TABLE: [(&str, usize, usize); 6] = [
    ("s02_indexing", 256, 98_304),
    ("s03_integrity", 256, 163_840),
    ("s04_structured_data", 256, 131_072),
    ("s05_link_graph", 256, 131_072),
    ("s06_duplicates", 128, 98_304),
    ("s08_resources", 256, 163_840),
];

/// What a locator can resolve against: one entry per `pages[N]`.
pub(crate) struct PageRef {
    pub url: String,
    pub is_resource: bool,
    pub links: usize,
    pub relationships: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Top<'a> {
    version: u64,
    semantics: String,
    max_bytes: u64,
    budget_state: String,
    #[serde(borrow)]
    families: Set<'a>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Set<'a> {
    #[serde(borrow)]
    s02_indexing: &'a RawValue,
    #[serde(borrow)]
    s03_integrity: &'a RawValue,
    #[serde(borrow)]
    s04_structured_data: &'a RawValue,
    #[serde(borrow)]
    s05_link_graph: &'a RawValue,
    #[serde(borrow)]
    s06_duplicates: &'a RawValue,
    #[serde(borrow)]
    s08_resources: &'a RawValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Section {
    #[serde(rename = "section_version")]
    version: u64,
    semantics: String,
    state: String,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    reason: Option<String>,
    coverage: Coverage,
    summary: Value,
    items: Vec<Item>,
    items_total: u64,
    omitted_items: u64,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    omitted_reason: Option<String>,
    truncated: bool,
    max_items: u64,
    max_bytes: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // shape only: producer-asserted counts
struct Coverage {
    entities: u64,
    eligible: u64,
    attempted: u64,
    observed: u64,
    unknown: u64,
    unknown_reasons: BTreeMap<String, u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Item {
    #[serde(deserialize_with = "Deserialize::deserialize")]
    entity_id: Option<String>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    locator: Option<String>,
    kind: String,
    outcome: String,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    reason: Option<String>,
    facts: Map<String, Value>,
}

fn code(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
fn rank(outcome: &str) -> Option<u8> {
    Some(match outcome {
        "issue" => 0,
        "unknown" => 1,
        "observed" => 2,
        "pass" => 3,
        _ => return None,
    })
}
fn entity_id(url: &str, resource: bool) -> String {
    format!(
        "sha256:{:x}",
        Sha256::digest(
            format!(
                "seosmith-entity-v1\n{}\n{url}",
                if resource { "resource" } else { "page" }
            )
            .as_bytes()
        )
    )
}
fn depth(v: &Value) -> usize {
    match v {
        Value::Object(o) => 1 + o.values().map(depth).max().unwrap_or(0),
        Value::Array(a) => 1 + a.iter().map(depth).max().unwrap_or(0),
        _ => 0,
    }
}
/// Strings (keys included) within bounds and NUL-free.
fn strings_ok(v: &Value) -> bool {
    let s = |t: &str| t.len() <= MAX_STRING && !t.contains('\0');
    match v {
        Value::String(t) => s(t),
        Value::Array(a) => a.iter().all(strings_ok),
        Value::Object(o) => o.iter().all(|(k, v)| s(k) && strings_ok(v)),
        _ => true,
    }
}
fn compact_len(v: &impl serde::Serialize) -> Result<usize, E> {
    serde_json::to_vec(v).map(|b| b.len()).map_err(|_| E::Shape)
}
/// `/pages/N`, `/pages/N/links/M`, `/pages/N/relationships/M`; canonical decimals.
fn resolve<'a>(locator: &str, pages: &'a [PageRef]) -> Option<&'a PageRef> {
    let rest = locator.strip_prefix("/pages/")?;
    let mut parts = rest.split('/');
    let index = |s: &str| {
        let n: usize = s.parse().ok()?;
        (n.to_string() == s).then_some(n)
    };
    let page = pages.get(index(parts.next()?)?)?;
    match (parts.next(), parts.next(), parts.next()) {
        (None, None, None) => Some(page),
        (Some("links"), Some(m), None) => (index(m)? < page.links).then_some(page),
        (Some("relationships"), Some(m), None) => (index(m)? < page.relationships).then_some(page),
        _ => None,
    }
}

#[allow(clippy::too_many_lines)]
fn section(raw: &RawValue, want: (&str, usize, usize), pages: &[PageRef]) -> Result<(), E> {
    let s: Section = serde_json::from_str(raw.get()).map_err(|_| E::Shape)?;
    if s.version != 1
        || s.semantics.is_empty()
        || s.semantics.len() > 64
        || s.max_items != want.1 as u64
        || s.max_bytes != want.2 as u64
    {
        return Err(E::Shape);
    }
    // §3.2-6 bounds: whole section, summary, item count.
    let whole: Value = serde_json::from_str(raw.get()).map_err(|_| E::Shape)?;
    if compact_len(&whole)? > want.2
        || s.items.len() > want.1
        || !s.summary.is_object()
        || compact_len(&s.summary)? > MAX_SUMMARY_BYTES
        || !strings_ok(&s.summary)
    {
        return Err(E::Bounds);
    }
    if !matches!(s.state.as_str(), "complete" | "partial" | "unavailable")
        || s.reason.as_deref().is_some_and(|r| !code(r))
    {
        return Err(E::Shape);
    }
    // §3.2-1/2/3
    if s.items_total != s.items.len() as u64 + s.omitted_items
        || s.truncated != (s.omitted_items > 0)
    {
        return Err(E::Shape);
    }
    match (&s.omitted_reason, s.truncated) {
        (Some(r), true)
            if matches!(
                r.as_str(),
                "family_item_limit"
                    | "family_byte_budget"
                    | "report_byte_budget"
                    | "analysis_deadline"
            ) => {}
        (None, false) => {}
        _ => return Err(E::Shape),
    }
    let unknown_total: u64 = s.coverage.unknown_reasons.values().sum();
    if unknown_total != s.coverage.unknown || s.coverage.unknown_reasons.keys().any(|k| !code(k)) {
        return Err(E::Shape);
    }
    if (s.state == "complete" && (s.coverage.unknown != 0 || s.truncated))
        || (s.state == "unavailable" && (!s.items.is_empty() || s.reason.is_none()))
    {
        return Err(E::Shape);
    }
    // §3.2-4/5/6/7 per item
    let mut unknown_items = 0u64;
    let mut last: Option<(u8, Option<&str>, &str)> = None;
    for i in &s.items {
        let Some(r) = rank(&i.outcome) else {
            return Err(E::Shape);
        };
        if !code(&i.kind) || i.reason.as_deref().is_some_and(|x| !code(x)) {
            return Err(E::Shape);
        }
        match i.outcome.as_str() {
            "unknown" => {
                unknown_items += 1;
                if i.reason.is_none() {
                    return Err(E::Shape);
                }
            }
            "pass" => {
                // a capture omission is never a pass
                if matches!(
                    i.reason.as_deref(),
                    Some("collector_byte_limit" | "run_byte_limit")
                ) {
                    return Err(E::Shape);
                }
            }
            _ => {}
        }
        let facts = Value::Object(i.facts.clone());
        if depth(&facts) > MAX_FACTS_DEPTH
            || compact_len(&facts)? > MAX_FACTS_BYTES
            || !strings_ok(&facts)
        {
            return Err(E::Bounds);
        }
        match (&i.locator, &i.entity_id) {
            (Some(l), Some(e)) => {
                let page = resolve(l, pages).ok_or(E::Shape)?;
                if *e != entity_id(&page.url, page.is_resource) {
                    return Err(E::Shape);
                }
            }
            (None, None) => {
                // an item with no page: allowed only with a bounded facts.url
                if !matches!(i.facts.get("url"), Some(Value::String(u)) if !u.is_empty()) {
                    return Err(E::Shape);
                }
            }
            _ => return Err(E::Shape),
        }
        let key = (r, i.locator.as_deref(), i.kind.as_str());
        if last.is_some_and(|l| l > key) {
            return Err(E::Shape);
        }
        last = Some(key);
    }
    if unknown_items > s.coverage.unknown {
        return Err(E::Shape);
    }
    Ok(())
}

/// Validates the member. `None` (absent) is `Shape`: it is required under v2.
///
/// # Errors
/// See the module doc for the error mapping.
pub(crate) fn check(raw: Option<&RawValue>, pages: &[PageRef], deadline: Instant) -> Result<(), E> {
    let raw = raw.ok_or(E::Shape)?;
    if raw.get().len() > MAX_FAMILIES_BYTES {
        return Err(E::Bounds);
    }
    let top: Top = serde_json::from_str(raw.get()).map_err(|_| E::Shape)?;
    if top.version != 1 {
        return Err(E::UnsupportedSchema);
    }
    if top.semantics != "s14-families-1"
        || top.max_bytes != MAX_FAMILIES_BYTES as u64
        || !matches!(
            top.budget_state.as_str(),
            "within_budget" | "report_byte_budget"
        )
    {
        return Err(E::Shape);
    }
    let f = &top.families;
    for (raw, want) in [
        (f.s02_indexing, TABLE[0]),
        (f.s03_integrity, TABLE[1]),
        (f.s04_structured_data, TABLE[2]),
        (f.s05_link_graph, TABLE[3]),
        (f.s06_duplicates, TABLE[4]),
        (f.s08_resources, TABLE[5]),
    ] {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        section(raw, want, pages)?;
    }
    Ok(())
}
