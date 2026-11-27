//! Receiver-side HANDMADE wire-2 cases (WP8c-1). The committed corpus under
//! `tests/fixtures/s14-wire2-v1/` is the `SEOsmith` 8b-4 set (byte-copies, see its
//! `SOURCE`). This generator derives wire-2 cases from a committed wire-1 fixture by
//! `to_v2` plus one named mutation; nothing here is committed as a file. The
//! five paths in `RECEIVER_ONLY` (`wire2_conformance.rs`) are byte-pinned and asserted
//! case by case; every generated positive is also compared with its v1 twin by
//! `check_consistency_v2_matches_the_v1_twin`.
#![allow(
    dead_code,
    clippy::too_many_lines,
    clippy::format_push_string,
    clippy::semicolon_if_nothing_returned
)]
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const V1_REV: &str = "s14-wire-1/full-population-1/evidence-v1";
pub const V2_REV: &str = "s14-wire-2/full-population-1/evidence-v1/families-v1";

pub fn sha_hex(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
/// A9 framing, implemented independently of the receiver.
pub fn candidates_digest(ids: &[String]) -> String {
    let mut s = format!("seosmith-candidates-v1\ncount={}\n", ids.len());
    for id in ids {
        s.push_str(&format!("id={}:{id}\n", id.len()));
    }
    s.push_str("end\n");
    format!("sha256:{}", sha_hex(s.as_bytes()))
}
pub fn entity_id(url: &str, resource: bool) -> String {
    format!(
        "sha256:{}",
        sha_hex(
            format!(
                "seosmith-entity-v1\n{}\n{url}",
                if resource { "resource" } else { "page" }
            )
            .as_bytes()
        )
    )
}

pub const FAMILIES: [(&str, &str, usize, usize); 6] = [
    ("s02_indexing", "s02-indexing-1", 256, 98_304),
    ("s03_integrity", "s03-integrity-1", 256, 163_840),
    ("s04_structured_data", "s04-structured-1", 256, 131_072),
    ("s05_link_graph", "s05-graph-1", 256, 131_072),
    ("s06_duplicates", "s06-duplicates-1", 128, 98_304),
    ("s08_resources", "s08-resources-1", 256, 163_840),
];

fn rank(outcome: &str) -> u8 {
    match outcome {
        "issue" => 0,
        "unknown" => 1,
        "observed" => 2,
        _ => 3,
    }
}
pub fn item(pages: &[Value], n: usize, kind: &str, outcome: &str, reason: Option<&str>) -> Value {
    let n = n % pages.len();
    let p = &pages[n];
    json!({"entity_id": entity_id(p["url"].as_str().unwrap(), p["is_resource"].as_bool().unwrap()),
        "locator": format!("/pages/{n}"), "kind": kind, "outcome": outcome, "reason": reason,
        "facts": {"url_len": p["url"].as_str().unwrap().len()}})
}
pub fn sort_items(items: &mut [Value]) {
    items.sort_by(|a, b| {
        let key = |v: &Value| {
            (
                rank(v["outcome"].as_str().unwrap()),
                v["locator"].as_str().map(str::to_owned),
                v["kind"].as_str().unwrap().to_owned(),
            )
        };
        key(a).cmp(&key(b))
    });
}
/// One section. `unknown` counts `unknown` items plus `extra_unknown` omitted ones.
pub fn section(
    pages: &[Value],
    spec: (&str, &str, usize, usize),
    mut items: Vec<Value>,
    state: &str,
    reason: Option<&str>,
    omitted: u64,
    omitted_reason: Option<&str>,
) -> Value {
    sort_items(&mut items);
    let mut reasons = std::collections::BTreeMap::<String, u64>::new();
    for i in &items {
        if i["outcome"] == "unknown" {
            *reasons
                .entry(i["reason"].as_str().unwrap().to_owned())
                .or_default() += 1;
        }
    }
    let unknown: u64 = reasons.values().sum();
    let n = pages.len() as u64;
    json!({"section_version":1,"semantics":spec.1,"state":state,"reason":reason,
        "coverage":{"entities":n,"eligible":n,"attempted":n,"observed":n-unknown.min(n),
            "unknown":unknown,"unknown_reasons":reasons},
        "summary":{"pages":n},"items":items,"items_total":items.len() as u64+omitted,
        "omitted_items":omitted,"omitted_reason":omitted_reason,"truncated":omitted>0,
        "max_items":spec.2,"max_bytes":spec.3})
}
pub fn families_for(pages: &[Value], scenario: &str) -> Value {
    let mut fam = serde_json::Map::new();
    let mut budget_state = "within_budget";
    for (idx, spec) in FAMILIES.iter().enumerate() {
        let n = 4usize;
        let mut items: Vec<Value> = (0..n)
            .map(|i| {
                item(
                    pages,
                    i,
                    &format!("page_state_{i}"),
                    if i == 0 { "issue" } else { "pass" },
                    None,
                )
            })
            .collect();
        let (mut state, mut reason, mut omitted, mut omitted_reason) =
            ("complete", None, 0u64, None);
        match (scenario, idx) {
            ("partial", 0 | 2) => {
                items.push(item(
                    pages,
                    4,
                    "source_gap",
                    "unknown",
                    Some("robots_unavailable"),
                ));
                state = "partial";
            }
            ("capture-omissions", _) => {
                items.push(item(
                    pages,
                    4,
                    "collector_gap",
                    "unknown",
                    Some("collector_byte_limit"),
                ));
                items.push(item(pages, 5, "run_gap", "unknown", Some("run_byte_limit")));
                state = "partial";
            }
            ("family-item-limit", 3) => {
                state = "partial";
                omitted = 40;
                omitted_reason = Some("family_item_limit");
            }
            ("family-byte-budget", 1) => {
                state = "partial";
                omitted = 7;
                omitted_reason = Some("family_byte_budget");
            }
            ("report-budget-degraded", _) => {
                budget_state = "report_byte_budget";
                if idx >= 4 {
                    items.clear();
                    state = "unavailable";
                    reason = Some("report_byte_budget");
                } else {
                    state = "partial";
                    omitted = 3;
                    omitted_reason = Some("report_byte_budget");
                }
            }
            ("unbound-url", 1) => {
                items.push(
                    json!({"entity_id":null,"locator":null,"kind":"sitemap_entry",
                    "outcome":"issue","reason":null,"facts":{"url":"https://example.com/x"}}),
                );
            }
            _ => {}
        }
        if state == "partial" && scenario == "partial" {
            reason = None;
        }
        fam.insert(
            spec.0.to_owned(),
            section(pages, *spec, items, state, reason, omitted, omitted_reason),
        );
    }
    json!({"version":1,"semantics":"s14-families-1","max_bytes":786_432,
        "budget_state":budget_state,"families":fam})
}

/// Wire-1 report -> wire-2 report (label, digest, digest-form manifest, families).
pub fn to_v2(v1: &Value, scenario: &str) -> Value {
    let mut text = serde_json::to_string(v1).unwrap();
    let g = &v1["policy_guidance"];
    let canon = g["candidate"]["policy_canonical_json"].as_str().unwrap();
    let old_digest = g["candidate"]["policy_digest"].as_str().unwrap();
    let new_canon = canon.replace(
        "\"validator_version\":\"s14-wire-1\",\"wire_contract_version\":\"s14-wire-1\"",
        "\"validator_version\":\"s14-wire-2\",\"wire_contract_version\":\"s14-wire-2\"",
    );
    assert_ne!(canon, new_canon);
    let new_digest = format!("sha256:{}", sha_hex(new_canon.as_bytes()));
    text = text.replace(
        &serde_json::to_string(canon).unwrap(),
        &serde_json::to_string(&new_canon).unwrap(),
    );
    text = text.replace(old_digest, &new_digest);
    let mut v: Value = serde_json::from_str(&text).unwrap();
    v["policy_guidance"]["version"] = "s14-wire-2".into();
    for row in v["policy_guidance"]["manifest"].as_array_mut().unwrap() {
        let ids: Vec<String> = serde_json::from_value(row["candidates"].clone()).unwrap();
        let o = row.as_object_mut().unwrap();
        o.remove("candidates");
        o.insert("candidates_count".into(), json!(ids.len()));
        o.insert("candidates_digest".into(), json!(candidates_digest(&ids)));
    }
    let pages = v["pages"].as_array().unwrap().clone();
    v["evidence_families"] = families_for(&pages, scenario);
    v
}

pub fn bytes(v: &Value) -> Vec<u8> {
    let mut b = serde_json::to_vec(v).unwrap();
    b.push(b'\n');
    b
}

pub struct Case {
    pub path: String,
    pub base: &'static str,
    pub bytes: Vec<u8>,
    /// None = admitted; Some((stage, error)) = rejected.
    pub expect: Option<(&'static str, &'static str)>,
    pub note: &'static str,
}

fn load(name: &str) -> Value {
    let p = format!(
        "{}/tests/fixtures/s14-schema4-v1/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}
fn pad(v: &Value, key: &str, n: usize) -> Vec<u8> {
    // Whitespace padding inside the named top-level member keeps the JSON valid.
    let mut b = serde_json::to_vec(v).unwrap();
    let k = format!("\"{key}\":");
    // serde_json's RawValue drops whitespace around a value, so pad just inside it
    let at = String::from_utf8_lossy(&b).find(&k).unwrap() + k.len() + 1;
    b.splice(at..at, std::iter::repeat_n(b' ', n));
    b.push(b'\n');
    b
}

pub fn cases() -> Vec<Case> {
    let out = std::cell::RefCell::new(Vec::new());
    let add = |path: &str, base: &'static str, b: Vec<u8>, expect, note: &'static str| {
        out.borrow_mut().push(Case {
            path: path.to_owned(),
            base,
            bytes: b,
            expect,
            note,
        });
    };
    let clean = load("complete-clean.json");
    // ---- positives
    for (name, base, scen, note) in [
        (
            "complete-small",
            "complete-clean.json",
            "complete",
            "all six families complete",
        ),
        (
            "partial-sources",
            "partial-sources.json",
            "partial",
            "families partial with reasons",
        ),
        (
            "capture-omissions",
            "complete-clean.json",
            "capture-omissions",
            "collector_byte_limit/run_byte_limit are unknown, never pass",
        ),
        (
            "family-item-limit",
            "complete-clean.json",
            "family-item-limit",
            "family_item_limit truncation",
        ),
        (
            "family-byte-budget",
            "complete-clean.json",
            "family-byte-budget",
            "family_byte_budget truncation",
        ),
        (
            "report-budget-degraded",
            "complete-clean.json",
            "report-budget-degraded",
            "report_byte_budget degradation, unavailable sections",
        ),
        (
            "unbound-url-item",
            "complete-clean.json",
            "unbound-url",
            "null locator with facts.url",
        ),
        (
            "s14-record-limit",
            "mixed-caps-exceeded.json",
            "complete",
            "per-rule record omissions present",
        ),
        (
            "external-links-checked-v2",
            "external-links-checked.json",
            "complete",
            "out-of-scope entity and edge ids in v1 list",
        ),
    ] {
        let v = to_v2(&load(base), scen);
        add(
            &format!("positive/{name}.json"),
            base,
            bytes(&v),
            None,
            note,
        );
    }
    let mut v = to_v2(&clean, "complete");
    let obs: Vec<Value> = (0..200).map(|i| json!({"n": i})).collect();
    v["evidence_contract"]["observations"] = Value::Array(obs);
    add(
        "positive/wire2-limits.json",
        "complete-clean.json",
        bytes(&v),
        None,
        "200 observations (> v1 limit 128), v2 limit 1024",
    );
    // F2: whitespace padding makes the raw member exceed the cap while the compact bytes
    // (the contract's measure, section 3.2-6) stay far below it: admitted.
    {
        let v = to_v2(&clean, "complete");
        add(
            "positive/families-raw-over-cap-compact-ok.json",
            "complete-clean.json",
            pad(&v, "evidence_families", 800_000),
            None,
            "evidence_families raw > 786,432 B, compact small: bounds count compact bytes",
        );
        add(
            "positive/manifest-raw-over-16384-compact-ok.json",
            "complete-clean.json",
            pad(&v, "manifest", 17_000),
            None,
            "v2 manifest raw > 16,384 B, compact small: bounds count compact bytes",
        );
    }
    // F5: depth convention. `facts` itself is level 1, so four nested objects are
    // admitted and the negative `families-facts-too-deep` (five) is rejected.
    {
        let mut v = to_v2(&clean, "complete");
        v["evidence_families"]["families"]["s02_indexing"]["items"][0]["facts"] =
            json!({"a":{"b":{"c":{"d":1}}}});
        add(
            "positive/families-facts-depth-4.json",
            "complete-clean.json",
            bytes(&v),
            None,
            "facts nested to depth 4 (facts itself counts as level 1): the boundary",
        );
    }
    // F4: `/pages/N/links/M` and `/pages/N/relationships/M` locators (crawl page 0
    // has 23 links and 23 relationships).
    let crawl = load("crawl.json");
    let locate = |sec: &str, loc: &str| {
        let mut v = to_v2(&crawl, "complete");
        v["evidence_families"]["families"][sec]["items"][0]["locator"] = json!(loc);
        v
    };
    add(
        "positive/links-locator-v2.json",
        "crawl.json",
        bytes(&locate("s05_link_graph", "/pages/0/links/22")),
        None,
        "item locator /pages/0/links/22 (last link of page 0)",
    );
    add(
        "positive/relationships-locator-v2.json",
        "crawl.json",
        bytes(&locate("s08_resources", "/pages/0/relationships/22")),
        None,
        "item locator /pages/0/relationships/22 (last relationship of page 0)",
    );
    // ---- inspection negatives
    let base = to_v2(&clean, "complete");
    let mutate = |name: &str,
                  note: &'static str,
                  e: (&'static str, &'static str),
                  f: &dyn Fn(&mut Value)| {
        let mut v = base.clone();
        f(&mut v);
        add(
            &format!("negative/{name}.json"),
            "complete-clean.json",
            bytes(&v),
            Some(e),
            note,
        );
    };
    let ins = |e| ("inspection", e);
    mutate("families-null-v2", "explicit null", ins("Shape"), &|v| {
        v["evidence_families"] = Value::Null
    });
    mutate(
        "families-missing-v2",
        "absent under v2",
        ins("Shape"),
        &|v| {
            v.as_object_mut().unwrap().remove("evidence_families");
        },
    );
    mutate("families-not-object-v2", "array", ins("Shape"), &|v| {
        v["evidence_families"] = json!([])
    });
    mutate(
        "families-unknown-top-key",
        "unknown key at top",
        ins("Shape"),
        &|v| v["evidence_families"]["extra"] = json!(1),
    );
    mutate(
        "families-unknown-family-key",
        "unknown family",
        ins("Shape"),
        &|v| v["evidence_families"]["families"]["s99"] = json!({}),
    );
    mutate(
        "families-missing-family",
        "family absent",
        ins("Shape"),
        &|v| {
            v["evidence_families"]["families"]
                .as_object_mut()
                .unwrap()
                .remove("s08_resources");
        },
    );
    mutate(
        "families-unknown-section-key",
        "unknown key in section",
        ins("Shape"),
        &|v| v["evidence_families"]["families"]["s02_indexing"]["x"] = json!(1),
    );
    mutate(
        "families-unknown-coverage-key",
        "unknown key in coverage",
        ins("Shape"),
        &|v| v["evidence_families"]["families"]["s02_indexing"]["coverage"]["x"] = json!(1),
    );
    mutate(
        "families-unknown-item-key",
        "unknown key in item",
        ins("Shape"),
        &|v| v["evidence_families"]["families"]["s02_indexing"]["items"][0]["x"] = json!(1),
    );
    mutate(
        "families-bad-version",
        "version 2",
        ins("UnsupportedSchema"),
        &|v| v["evidence_families"]["version"] = json!(2),
    );
    mutate(
        "families-bad-budget-state",
        "unknown budget_state",
        ins("Shape"),
        &|v| v["evidence_families"]["budget_state"] = json!("lots"),
    );
    mutate(
        "families-items-total-mismatch",
        "invariant 1",
        ins("Shape"),
        &|v| v["evidence_families"]["families"]["s02_indexing"]["items_total"] = json!(99),
    );
    mutate(
        "families-truncated-mismatch",
        "invariant 2: truncated without omissions",
        ins("Shape"),
        &|v| v["evidence_families"]["families"]["s02_indexing"]["truncated"] = json!(true),
    );
    mutate(
        "families-omission-reason-missing",
        "invariant 2: omissions without reason",
        ins("Shape"),
        &|v| {
            let s = &mut v["evidence_families"]["families"]["s02_indexing"];
            s["omitted_items"] = json!(2);
            s["items_total"] = json!(6);
            s["truncated"] = json!(true);
        },
    );
    mutate(
        "families-complete-with-unknown",
        "invariant 3",
        ins("Shape"),
        &|v| {
            let s = &mut v["evidence_families"]["families"]["s02_indexing"];
            s["coverage"]["unknown"] = json!(1);
            s["coverage"]["unknown_reasons"] = json!({"robots_unavailable":1});
        },
    );
    mutate(
        "families-unavailable-with-items",
        "invariant 3",
        ins("Shape"),
        &|v| {
            let s = &mut v["evidence_families"]["families"]["s02_indexing"];
            s["state"] = json!("unavailable");
            s["reason"] = json!("analyzer_error");
        },
    );
    mutate(
        "families-unknown-without-reason",
        "invariant 4",
        ins("Shape"),
        &|v| {
            let s = &mut v["evidence_families"]["families"]["s02_indexing"];
            s["items"][1]["outcome"] = json!("unknown");
        },
    );
    mutate(
        "families-unknown-reasons-sum",
        "invariant 4: sum mismatch",
        ins("Shape"),
        &|v| {
            let s = &mut v["evidence_families"]["families"]["s02_indexing"];
            s["coverage"]["unknown"] = json!(3);
            s["state"] = json!("partial");
        },
    );
    mutate(
        "families-pass-with-capture-omission",
        "invariant 4: omission reported as pass",
        ins("Shape"),
        &|v| {
            v["evidence_families"]["families"]["s02_indexing"]["items"][1]["reason"] =
                json!("collector_byte_limit");
        },
    );
    mutate(
        "families-locator-unresolved",
        "invariant 5",
        ins("Shape"),
        &|v| {
            v["evidence_families"]["families"]["s02_indexing"]["items"][0]["locator"] =
                json!("/pages/9999");
        },
    );
    mutate(
        "families-locator-bad-form",
        "invariant 5",
        ins("Shape"),
        &|v| {
            v["evidence_families"]["families"]["s02_indexing"]["items"][0]["locator"] =
                json!("/pagez/0");
        },
    );
    mutate(
        "families-entity-id-mismatch",
        "invariant 5",
        ins("Shape"),
        &|v| {
            v["evidence_families"]["families"]["s02_indexing"]["items"][0]["entity_id"] =
                json!(format!("sha256:{}", "0".repeat(64)));
        },
    );
    mutate(
        "families-null-locator-no-url",
        "invariant 5",
        ins("Shape"),
        &|v| {
            let i = &mut v["evidence_families"]["families"]["s02_indexing"]["items"][0];
            i["locator"] = Value::Null;
            i["entity_id"] = Value::Null;
        },
    );
    for (name, sec, loc, note) in [
        (
            "families-link-locator-out-of-range",
            "s05_link_graph",
            "/pages/0/links/23",
            "links/M with M = len",
        ),
        (
            "families-relationship-locator-out-of-range",
            "s08_resources",
            "/pages/0/relationships/23",
            "relationships/M with M = len",
        ),
        (
            "families-link-locator-on-linkless-page",
            "s05_link_graph",
            "/pages/1/links/0",
            "links/0 on a page with no links",
        ),
        (
            "families-relationship-locator-on-empty-page",
            "s08_resources",
            "/pages/1/relationships/0",
            "relationships/0 on a page with none",
        ),
    ] {
        add(
            &format!("negative/{name}.json"),
            "crawl.json",
            bytes(&locate(sec, loc)),
            Some(ins("Shape")),
            note,
        );
    }
    mutate(
        "families-facts-too-big",
        "invariant 6: facts > 4096 B",
        ins("Bounds"),
        &|v| {
            v["evidence_families"]["families"]["s02_indexing"]["items"][0]["facts"] =
                json!({"a": "x".repeat(2000), "b": "y".repeat(2000), "c": "z".repeat(200)});
        },
    );
    mutate(
        "families-facts-too-deep",
        "invariant 6: depth > 4",
        ins("Bounds"),
        &|v| {
            v["evidence_families"]["families"]["s02_indexing"]["items"][0]["facts"] =
                json!({"a":{"b":{"c":{"d":{"e":1}}}}});
        },
    );
    mutate(
        "families-items-over-max",
        "invariant 6: more items than max_items",
        ins("Bounds"),
        &|v| {
            let s = &mut v["evidence_families"]["families"]["s06_duplicates"];
            let one = s["items"][0].clone();
            s["items"] = Value::Array(vec![one; 129]);
            s["items_total"] = json!(129);
        },
    );
    mutate("families-unsorted", "invariant 7", ins("Shape"), &|v| {
        v["evidence_families"]["families"]["s02_indexing"]
            .as_object_mut()
            .unwrap()["items"]
            .as_array_mut()
            .unwrap()
            .reverse();
    });
    mutate(
        "families-wrong-max-bytes",
        "section max_bytes differs from the table",
        ins("Shape"),
        &|v| {
            v["evidence_families"]["families"]["s02_indexing"]["max_bytes"] = json!(1);
        },
    );
    mutate(
        "manifest-list-under-v2",
        "row still carries candidates",
        ins("Bounds"),
        &|v| {
            let r = &mut v["policy_guidance"]["manifest"][0];
            r["candidates"] = json!([]);
        },
    );
    mutate(
        "manifest-row-missing-digest",
        "row lacks candidates_digest",
        ins("Bounds"),
        &|v| {
            v["policy_guidance"]["manifest"][0]
                .as_object_mut()
                .unwrap()
                .remove("candidates_digest");
        },
    );
    mutate(
        "manifest-row-bad-digest",
        "malformed digest",
        ins("Bounds"),
        &|v| {
            v["policy_guidance"]["manifest"][0]["candidates_digest"] = json!("sha256:ABC");
        },
    );
    mutate(
        "manifest-row-extra-key",
        "unknown row key",
        ins("Bounds"),
        &|v| {
            v["policy_guidance"]["manifest"][0]["x"] = json!(1);
        },
    );
    {
        // compact bytes over 16,384: valid digest-form rows, repeated
        let mut v = base.clone();
        let row = v["policy_guidance"]["manifest"][0].clone();
        let rows = v["policy_guidance"]["manifest"].as_array_mut().unwrap();
        while serde_json::to_vec(&Value::Array(rows.clone()))
            .unwrap()
            .len()
            <= 16_384
        {
            rows.push(row.clone());
        }
        add(
            "negative/manifest-over-16384-v2.json",
            "complete-clean.json",
            bytes(&v),
            Some(ins("Bounds")),
            "v2 manifest compact > 16,384 B",
        );
    }
    mutate(
        "s01-obs-1025-v2",
        "1,025 observations",
        ins("Bounds"),
        &|v| {
            v["evidence_contract"]["observations"] =
                Value::Array((0..1025).map(|i| json!({"n": i})).collect());
        },
    );
    mutate(
        "s01-evals-1025-v2",
        "1,025 evaluations",
        ins("Bounds"),
        &|v| {
            v["evidence_contract"]["evaluations"] =
                Value::Array((0..1025).map(|i| json!({"n": i})).collect());
        },
    );
    mutate(
        "unknown-wire-label",
        "s14-wire-3 (no families, so the label is the only defect)",
        ins("Bounds"),
        &|v| {
            v["policy_guidance"]["version"] = json!("s14-wire-3");
            v.as_object_mut().unwrap().remove("evidence_families");
        },
    );
    mutate(
        "unknown-wire-label-with-families",
        "families under an unrecognised label",
        ins("Shape"),
        &|v| v["policy_guidance"]["version"] = json!("s14-wire-3"),
    );
    // ---- summary negatives
    let sm = |e| ("summary", e);
    mutate(
        "manifest-count-mismatch",
        "candidates_count off by one",
        sm("SemanticMismatch"),
        &|v| {
            let c = v["policy_guidance"]["manifest"][0]["candidates_count"]
                .as_u64()
                .unwrap();
            v["policy_guidance"]["manifest"][0]["candidates_count"] = json!(c + 1);
        },
    );
    mutate(
        "manifest-count-below-emitted",
        "candidates_count < emitted",
        sm("SemanticMismatch"),
        &|v| {
            v["policy_guidance"]["manifest"][0]["candidates_count"] = json!(0);
        },
    );
    mutate(
        "manifest-digest-mismatch",
        "digest of a different list",
        sm("SemanticMismatch"),
        &|v| {
            v["policy_guidance"]["manifest"][0]["candidates_digest"] =
                json!(candidates_digest(&["x".to_owned()]));
        },
    );
    {
        // digest-form rows under the v1 label: rejected at summary (unchanged v1 behaviour)
        let mut v = base.clone();
        let d1 = clean["policy_guidance"].clone();
        v["policy_guidance"]["version"] = d1["version"].clone();
        v["policy_guidance"]["candidate"] = d1["candidate"].clone();
        v.as_object_mut().unwrap().remove("evidence_families");
        add(
            "negative/manifest-digest-under-v1.json",
            "complete-clean.json",
            bytes(&v),
            Some(sm("SemanticMismatch")),
            "digest rows under the v1 label",
        );
    }
    // ---- population negative
    {
        let mut v = to_v2(&load("partial-sources.json"), "partial");
        let first = v["findings"][0].clone();
        v["findings"][1] = first;
        add(
            "negative/population-duplicate-finding-v2.json",
            "partial-sources.json",
            bytes(&v),
            Some(("population", "SemanticMismatch")),
            "duplicate multiplicity (population stage)",
        );
    }
    // ---- v1 negatives for families
    for (name, val) in [
        ("families-null-v1", Value::Null),
        ("families-object-v1", json!({"version":1})),
    ] {
        let mut v = clean.clone();
        v["evidence_families"] = val;
        add(
            &format!("negative/{name}.json"),
            "complete-clean.json",
            bytes(&v),
            Some(ins("Shape")),
            "families under the v1 label",
        );
    }
    out.into_inner()
}
