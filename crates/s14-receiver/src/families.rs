//! Wire-2 `evidence_families` (families-v1) validation, from the raw bytes.
//!
//! HTP validates the bounded shape and the bindings; it does not recompute the
//! families (they are producer-asserted, excluded from population equality). The
//! member is required and an object under `s14-wire-2`, every level rejects
//! unknown keys, and an explicit `null` is never read as absent.
//!
//! Error mapping (the parity pair compares these names):
//! * `Bounds`: compact size > 786,432 B; section/item/summary/facts byte or depth or
//!   count bounds (§3.2-6).
//! * `UnsupportedSchema`: `version` is present and is not the integer 1 (any other
//!   number, a string, `null`), decided before the strict parse, as in `check_evidence`.
//!   A missing `version` or a non-object is `Shape`.
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
    #[allow(dead_code)] // gated on the raw value before this parse
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
    #[allow(dead_code)] // gated on the raw value before this parse
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
/// Nesting depth; the `facts` object itself is level 1, so `MAX_FACTS_DEPTH` = 4 admits
/// `{"a":{"b":{"c":{"d":1}}}}` and rejects one more level.
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
/// Compact serialized JSON bytes (`serde_json::to_vec`) of a raw member.
pub(crate) fn compact_raw_len(raw: &RawValue) -> Result<usize, E> {
    let v: Value = serde_json::from_str(raw.get()).map_err(|_| E::Shape)?;
    compact_len(&v)
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
    // checked: a wrapped sum would admit a false invariant in release builds (R1)
    if (s.items.len() as u64).checked_add(s.omitted_items) != Some(s.items_total)
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
    let unknown_total = s
        .coverage
        .unknown_reasons
        .values()
        .try_fold(0u64, |a, v| a.checked_add(*v));
    if unknown_total != Some(s.coverage.unknown)
        || s.coverage.unknown_reasons.keys().any(|k| !code(k))
    {
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
    // compact bytes (3.2-6), not the raw length: padding is not content
    if compact_raw_len(raw)? > MAX_FAMILIES_BYTES {
        return Err(E::Bounds);
    }
    // The version gate runs before the strict parse, like `check_evidence`: a future
    // families version may add keys and must read as unsupported, not as a bad v1 (R2).
    let probe: Value = serde_json::from_str(raw.get()).map_err(|_| E::Shape)?;
    match probe.as_object().ok_or(E::Shape)?.get("version") {
        Some(v) if v.as_u64() == Some(1) => {}
        Some(_) => return Err(E::UnsupportedSchema),
        None => return Err(E::Shape),
    }
    let top: Top = serde_json::from_str(raw.get()).map_err(|_| E::Shape)?;
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

#[cfg(test)]
mod tests {
    //! F2 (review-8c1-h): the 786,432 B cap counts compact bytes (§3.2-6), at the
    //! boundary between compact and raw length. The six per-family caps sum to exactly
    //! 786,432 B, so only the envelope can push the compact total over the cap.
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    const URL: &str = "https://example.test/";

    fn section_of_len(max_items: usize, max_bytes: usize, target: usize) -> Value {
        let mk = |facts_len: &[usize]| {
            let items: Vec<Value> = facts_len
                .iter()
                .enumerate()
                .map(|(i, l)| {
                    json!({"entity_id": entity_id(URL, false), "locator": "/pages/0",
                        "kind": format!("k_{i:03}"), "outcome": "pass", "reason": null,
                        "facts": {"p": "x".repeat(*l / 2), "q": "y".repeat(*l - *l / 2)}})
                })
                .collect();
            json!({"section_version":1,"semantics":"t","state":"complete","reason":null,
                "coverage":{"entities":1,"eligible":1,"attempted":1,"observed":1,
                    "unknown":0,"unknown_reasons":{}},
                "summary":{"pages":1},"items":items.clone(),"items_total":items.len(),
                "omitted_items":0,"omitted_reason":null,"truncated":false,
                "max_items":max_items,"max_bytes":max_bytes})
        };
        let len = |v: &Value| serde_json::to_vec(v).unwrap().len();
        let mut lens: Vec<usize> = Vec::new();
        while len(&mk(&[lens.clone(), vec![0]].concat())) <= target {
            lens.push(3000); // two fields of 1,500 B: each string <= 2,048 B
        }
        lens.pop();
        let base = len(&mk(&[lens.clone(), vec![0]].concat()));
        lens.push(target - base);
        let v = mk(&lens);
        assert_eq!(len(&v), target);
        assert!(lens.len() <= max_items);
        v
    }
    fn families(shave: usize) -> String {
        let s: Vec<Value> = TABLE
            .iter()
            .map(|(_, items, bytes)| section_of_len(*items, *bytes, bytes - shave))
            .collect();
        serde_json::to_string(&json!({"version":1,"semantics":"s14-families-1",
            "max_bytes":MAX_FAMILIES_BYTES,"budget_state":"within_budget",
            "families":{"s02_indexing":s[0],"s03_integrity":s[1],"s04_structured_data":s[2],
                "s05_link_graph":s[3],"s06_duplicates":s[4],"s08_resources":s[5]}}))
        .unwrap()
    }
    fn run(text: String) -> Result<(), E> {
        let raw = RawValue::from_string(text).unwrap();
        let pages = [PageRef {
            url: URL.into(),
            is_resource: false,
            links: 0,
            relationships: 0,
        }];
        check(Some(&raw), &pages, Instant::now() + Duration::from_secs(30))
    }

    #[test]
    fn compact_bytes_over_the_cap_are_bounds() {
        let text = families(0);
        assert!(text.len() > MAX_FAMILIES_BYTES, "{}", text.len());
        assert!(matches!(run(text), Err(E::Bounds)));
    }
    #[test]
    fn compact_bytes_under_the_cap_are_admitted() {
        let text = families(1000);
        assert!(text.len() <= MAX_FAMILIES_BYTES, "{}", text.len());
        run(text).unwrap();
    }
    #[test]
    fn padding_that_pushes_the_raw_length_over_the_cap_is_not_content() {
        let text = families(1000);
        let padded = format!("{{{}{}", " ".repeat(100_000), &text[1..]);
        assert!(padded.len() > MAX_FAMILIES_BYTES);
        run(padded).unwrap();
    }

    // ---- review-8c1-o R1/R2 ----
    /// Valid families with one empty section per family, then `edit` applied to s02.
    fn small(edit: impl Fn(&mut Value)) -> String {
        let sec = |items: usize, bytes: usize| {
            json!({"section_version":1,"semantics":"t","state":"complete","reason":null,
                "coverage":{"entities":1,"eligible":1,"attempted":1,"observed":1,
                    "unknown":0,"unknown_reasons":{}},
                "summary":{"pages":1},"items":[],"items_total":0,
                "omitted_items":0,"omitted_reason":null,"truncated":false,
                "max_items":items,"max_bytes":bytes})
        };
        let mut s: Vec<Value> = TABLE.iter().map(|(_, i, b)| sec(*i, *b)).collect();
        edit(&mut s[0]);
        serde_json::to_string(&json!({"version":1,"semantics":"s14-families-1",
            "max_bytes":MAX_FAMILIES_BYTES,"budget_state":"within_budget",
            "families":{"s02_indexing":s[0],"s03_integrity":s[1],"s04_structured_data":s[2],
                "s05_link_graph":s[3],"s06_duplicates":s[4],"s08_resources":s[5]}}))
        .unwrap()
    }
    fn with_top(key: &str, v: Value) -> String {
        let mut t: Value = serde_json::from_str(&small(|_| {})).unwrap();
        match t.as_object_mut() {
            Some(o) if v.is_null() && key.starts_with('-') => {
                o.remove(&key[1..]);
            }
            Some(o) => {
                o.insert(key.into(), v);
            }
            None => unreachable!(),
        }
        serde_json::to_string(&t).unwrap()
    }

    #[test]
    fn a_small_valid_report_is_admitted() {
        run(small(|_| {})).unwrap();
    }
    #[test]
    fn items_total_sum_overflow_is_shape_not_a_panic_or_a_wrap() {
        // 1 item + u64::MAX omitted wraps to 0 == items_total in release builds
        let text = small(|s| {
            let item = json!({"entity_id": entity_id(URL, false), "locator": "/pages/0",
                "kind": "k_000", "outcome": "pass", "reason": null, "facts": {}});
            s["items"] = json!([item]);
            s["items_total"] = json!(0);
            s["omitted_items"] = json!(u64::MAX);
            s["truncated"] = json!(true);
            s["omitted_reason"] = json!("family_item_limit");
        });
        assert!(matches!(run(text), Err(E::Shape)));
    }
    #[test]
    fn unknown_reasons_sum_overflow_is_shape_not_a_panic_or_a_wrap() {
        // u64::MAX + 1 wraps to 0 == coverage.unknown in release builds
        let text = small(|s| {
            s["coverage"]["unknown_reasons"] = json!({"a": u64::MAX, "b": 1});
        });
        assert!(matches!(run(text), Err(E::Shape)));
    }
    #[test]
    fn version_other_than_one_is_unsupported_even_with_an_unknown_key() {
        // mirrors evidence_contract: the gate runs before the strict parse
        for v in [json!(2), json!("1"), json!(1.5), json!(null), json!(-1)] {
            let mut t: Value = serde_json::from_str(&small(|_| {})).unwrap();
            t["version"] = v.clone();
            t["new_in_v2"] = json!(true);
            assert!(
                matches!(run(t.to_string()), Err(E::UnsupportedSchema)),
                "{v} with unknown key"
            );
            t.as_object_mut().unwrap().remove("new_in_v2");
            assert!(
                matches!(run(t.to_string()), Err(E::UnsupportedSchema)),
                "{v} alone"
            );
        }
    }
    #[test]
    fn missing_version_or_non_object_is_shape() {
        assert!(matches!(
            run(with_top("-version", Value::Null)),
            Err(E::Shape)
        ));
        assert!(matches!(run("[1]".into()), Err(E::Shape)));
        assert!(matches!(run("null".into()), Err(E::Shape)));
    }
    #[test]
    fn version_one_with_an_unknown_key_stays_shape() {
        assert!(matches!(run(with_top("extra", json!(1))), Err(E::Shape)));
    }
}
