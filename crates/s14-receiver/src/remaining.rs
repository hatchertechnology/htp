//! Local reconstruction of the remaining finite rows, not an admission validator.
use crate::{InspectionError as E, check_consistency, check_scalar_advisories};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    time::Instant,
};

fn hash(s: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(s.as_bytes()))
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, E> {
    v.get(k).and_then(Value::as_str).ok_or(E::SemanticMismatch)
}
fn boolean(v: &Value, k: &str) -> Result<bool, E> {
    v.get(k).and_then(Value::as_bool).ok_or(E::SemanticMismatch)
}
fn status(p: &Value) -> Result<Option<u64>, E> {
    match p.get("status") {
        Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(v.as_u64().ok_or(E::SemanticMismatch)?)),
        None => Err(E::SemanticMismatch),
    }
}
fn unavailable(p: &Value) -> Result<bool, E> {
    let e = p.get("error").ok_or(E::SemanticMismatch)?;
    if !e.is_null() && !e.is_string() {
        return Err(E::SemanticMismatch);
    }
    Ok(boolean(p, "blocked_by_robots")?
        || !e.is_null()
        || status(p)?.is_none()
        || boolean(p, "extraction_truncated")?)
}
fn html(p: &Value) -> Result<bool, E> {
    let c = text(p, "content_type")?
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    Ok(status(p)?.is_some_and(|s| (200..300).contains(&s))
        && matches!(
            c.as_str(),
            "text/html" | "application/xhtml+xml" | "application/vnd.wap.xhtml+xml"
        ))
}
fn edge_source_usable(p: &Value) -> Result<bool, E> {
    Ok(!unavailable(p)? && html(p)?)
}
fn scope(s: &str, seed: &url::Url) -> Result<bool, E> {
    let u = url::Url::parse(s).map_err(|_| E::Url)?;
    Ok(matches!(u.scheme(), "http" | "https")
        && u.host_str() == seed.host_str()
        && u.port().is_none()
        && u.username().is_empty()
        && u.password().is_none())
}
fn entity(p: &Value) -> Result<String, E> {
    Ok(hash(&format!(
        "seosmith-entity-v1\n{}\n{}",
        if boolean(p, "is_resource")? {
            "resource"
        } else {
            "page"
        },
        text(p, "url")?
    )))
}
#[derive(Default)]
struct Row {
    ids: Vec<String>,
    records: Vec<Value>,
    elig: BTreeMap<String, u64>,
    attempts: BTreeMap<String, u64>,
    outcomes: BTreeMap<String, u64>,
    reasons: BTreeMap<String, u64>,
    omitted: u64,
    omission_reason: Option<&'static str>,
}
impl Row {
    fn add(
        &mut self,
        id: String,
        record: Value,
        total: &mut usize,
        obs: &mut usize,
    ) -> Result<(), E> {
        self.ids.push(id);
        for (field, map) in [
            ("eligibility", &mut self.elig),
            ("attempt", &mut self.attempts),
            ("outcome", &mut self.outcomes),
        ] {
            *map.entry(text(&record, field)?.to_owned()).or_default() += 1;
        }
        if record["outcome"] == "unknown" {
            *self
                .reasons
                .entry(text(&record, "reason")?.to_owned())
                .or_default() += 1;
        }
        let observation = record["category"] == "observation";
        if *total >= 512 || (observation && *obs >= 128) {
            self.omitted += 1;
            self.omission_reason = Some(if *total >= 512 {
                "record_limit"
            } else {
                "observation_limit"
            });
        } else {
            *total += 1;
            *obs += usize::from(observation);
            self.records.push(record);
        }
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    fn compare(
        &self,
        manifest: &Value,
        coverage: &Value,
        cat: &str,
        rule: &str,
        pointer: Option<&str>,
        complete: bool,
        wire: crate::wire::Wire,
    ) -> Result<(), E> {
        let m = match wire {
            crate::wire::Wire::V1 => {
                json!({"category":cat,"rule_id":rule,"rule_version":"s14-1","expected_pointer":pointer,"candidates":self.ids})
            }
            crate::wire::Wire::V2 => {
                json!({"category":cat,"rule_id":rule,"rule_version":"s14-1","expected_pointer":pointer,"candidates_count":self.ids.len(),"candidates_digest":crate::wire::candidates_digest(&self.ids)})
            }
        };
        let c = json!({"category":cat,"rule_id":rule,"candidates":self.ids.len(),"emitted":self.records.len(),"omitted":self.omitted,"omission_reason":self.omission_reason,"complete":complete && self.omitted==0 && !self.outcomes.contains_key("unknown"),"eligibility_counts":self.elig,"attempt_counts":self.attempts,"outcomes":self.outcomes,"unknown_reasons":self.reasons});
        if *manifest != m || *coverage != c {
            return Err(E::SemanticMismatch);
        }
        Ok(())
    }
}
#[allow(clippy::too_many_arguments, clippy::needless_pass_by_value)]
fn record(
    cat: &str,
    rule: &str,
    entity: &str,
    disc: &str,
    digest: &str,
    state: (&str, &str, &str, Option<&str>),
    source: Option<String>,
    expected: Option<String>,
    fact: Option<Value>,
    context: Option<String>,
    target: Option<String>,
) -> Value {
    let (elig, attempt, outcome, reason) = state;
    let id = hash(&format!(
        "seosmith-record-v1\n{cat}\n{rule}\ns14-1\n{entity}\n{disc}"
    ));
    let mut v = json!({"record_id":id,"category":cat,"rule_id":rule,"rule_version":"s14-1","entity_id":entity,"discriminator":disc,"eligibility":elig,"attempt":attempt,"outcome":outcome,"actual":if attempt=="completed" {"source"} else {"unavailable"},"source_locator":source,"expected":expected,"confidence":if attempt=="completed" {"high"} else {"unknown"},"interval_ref":"candidate.observed_at","policy_ref":digest,"reason":reason});
    if let Some(f) = fact {
        v["observed_fact"] = f;
    }
    if let Some(c) = context {
        v["context_locator"] = c.into();
    }
    if let Some(t) = target {
        v["target_locator"] = t.into();
    }
    v
}
/// Reconstruct the finite rules and deterministic record ordering. This is local
/// evidence only and does not create a validated admission object.
///
/// # Errors
/// Returns an inspection error, or a mismatch in a reconstructed field.
#[allow(clippy::too_many_lines)]
pub fn check_reconstructed_rules(input: &[u8], deadline: Instant) -> Result<(), E> {
    check_consistency(input, deadline)?;
    check_scalar_advisories(input, deadline)?;
    let wire = crate::wire::wire_of(input)?;
    let v: Value = crate::projection::project(input)?;
    let pages = v["pages"].as_array().ok_or(E::SemanticMismatch)?;
    let g = &v["policy_guidance"];
    let candidate = &g["candidate"];
    let manifest = g["manifest"].as_array().ok_or(E::SemanticMismatch)?;
    let coverage = candidate["coverage"]
        .as_array()
        .ok_or(E::SemanticMismatch)?;
    let records = candidate["records"].as_array().ok_or(E::SemanticMismatch)?;
    if manifest.len() != 13 || coverage.len() != 13 {
        return Err(E::SemanticMismatch);
    }
    let seed = url::Url::parse(text(&v["request"], "url")?).map_err(|_| E::Url)?;
    let digest = text(candidate, "policy_digest")?;
    let crawl = boolean(&v, "coverage_complete")?;
    let external = boolean(&v["request"], "check_external_links")?;
    let mut page_indices = HashMap::with_capacity(pages.len());
    for (index, p) in pages.iter().enumerate() {
        let u = text(p, "url")?;
        let kind = boolean(p, "is_resource")?;
        if page_indices.insert((u, kind), index).is_some() {
            return Err(E::SemanticMismatch);
        }
    }
    let mut total = (pages.len() * 6).min(512);
    let mut observations = 0usize;
    let mut expected_records = Vec::new();
    for rule in [
        "short_title",
        "long_title",
        "short_description",
        "long_description",
        "little_content",
        "too_many_links",
    ] {
        expected_records.extend(
            records
                .iter()
                .filter(|r| r["category"] == "advisory" && r["rule_id"] == rule)
                .cloned(),
        );
    }
    let defs = [
        ("observation", "noindex", "robots", None),
        ("observation", "http_redirect", "status", None),
        ("observation", "alternates_observed", "alternates", None),
        ("observation", "external_target", "status", None),
        (
            "policy_violation",
            "noindex",
            "robots",
            Some("/policy/require_indexable"),
        ),
        (
            "policy_violation",
            "http_redirect",
            "status",
            Some("/policy/forbid_redirects"),
        ),
    ];
    for (offset, (cat, rule, field, pointer)) in defs.iter().enumerate() {
        let mut row = Row::default();
        for (i, p) in pages.iter().enumerate() {
            if Instant::now() >= deadline {
                return Err(E::Deadline);
            }
            let inside = scope(text(p, "url")?, &seed)?;
            let resource = boolean(p, "is_resource")?;
            if *cat == "observation"
                && ((*rule == "external_target" && inside)
                    || (*rule != "external_target" && (!inside || resource)))
            {
                continue;
            }
            let id = entity(p)?;
            let st = status(p)?;
            let unavailable = unavailable(p)?
                || (*cat == "observation"
                    && matches!(*rule, "noindex" | "alternates_observed")
                    && !html(p)?);
            let applicable = inside
                && !resource
                && (*rule == "http_redirect" || html(p)?)
                && (if *rule == "noindex" {
                    boolean(&g["config"], "require_indexable")?
                } else if *rule == "http_redirect" {
                    boolean(&g["config"], "forbid_redirects")?
                } else {
                    true
                });
            let noindex = if *rule == "noindex" {
                text(p, "robots")?
                    .split([',', ' ', ';'])
                    .any(|s| s.eq_ignore_ascii_case("noindex") || s.eq_ignore_ascii_case("none"))
            } else {
                false
            };
            let redirect = st.is_some_and(|s| (300..400).contains(&s));
            let state = if unavailable {
                (
                    "unknown",
                    "not_attempted",
                    "unknown",
                    Some("source_unavailable"),
                )
            } else if *cat == "observation" {
                ("eligible", "completed", "observed", None)
            } else if !applicable {
                (
                    "ineligible",
                    "not_attempted",
                    "not_applicable",
                    Some("outside_applicability"),
                )
            } else {
                (
                    "eligible",
                    "completed",
                    if if *rule == "noindex" {
                        noindex
                    } else {
                        redirect
                    } {
                        "violation"
                    } else {
                        "no_violation"
                    },
                    None,
                )
            };
            let fact = if *cat == "observation" && state.1 == "completed" {
                Some(match *rule {
                    "noindex" => json!(noindex),
                    "http_redirect" => json!(redirect),
                    "external_target" => json!(st),
                    _ => {
                        let a = p["alternates"].as_array().ok_or(E::SemanticMismatch)?;
                        let mut has = false;
                        for x in a {
                            has |= text(x, "language")?.eq_ignore_ascii_case("x-default");
                        }
                        json!({"count":a.len(),"x_default_present":has})
                    }
                })
            } else {
                None
            };
            let r = record(
                cat,
                rule,
                &id,
                "self",
                digest,
                state,
                if state.1 == "completed" {
                    Some(format!("/pages/{i}/{field}"))
                } else {
                    None
                },
                if state.1 == "completed" {
                    pointer.map(str::to_owned)
                } else {
                    None
                },
                fact,
                None,
                None,
            );
            row.add(id, r, &mut total, &mut observations)?;
        }
        row.compare(
            &manifest[offset + 6],
            &coverage[offset + 6],
            cat,
            rule,
            *pointer,
            crawl && (*rule != "external_target" || external),
            wire,
        )?;
        expected_records.extend(row.records);
    }
    let mut row = Row::default();
    let mut intact = true;
    for (i, p) in pages.iter().enumerate() {
        if boolean(p, "is_resource")? || !scope(text(p, "url")?, &seed)? {
            continue;
        }
        let source_bad = !edge_source_usable(p)?;
        intact &= !source_bad;
        for (j, link) in p["links"]
            .as_array()
            .ok_or(E::SemanticMismatch)?
            .iter()
            .enumerate()
        {
            if Instant::now() >= deadline {
                return Err(E::Deadline);
            }
            let address = text(link, "url")?;
            if scope(address, &seed)? {
                continue;
            }
            let id = entity(p)?;
            let disc = format!("edge:{j}");
            let candidate_id = format!("{id}|{disc}");
            // A URL observed as both a page and a resource is ambiguous for this edge.
            let index = match (
                page_indices.get(&(address, false)),
                page_indices.get(&(address, true)),
            ) {
                (Some(_), Some(_)) => return Err(E::SemanticMismatch),
                (page, resource) => page.or(resource).copied(),
            };
            let target = index.map(|n| &pages[n]);
            let available = if let Some(t) = target {
                !source_bad
                    && status(t)?.is_some()
                    && t["error"].is_null()
                    && !boolean(t, "blocked_by_robots")?
            } else {
                false
            };
            let reason = if available {
                None
            } else if source_bad {
                Some("source_unavailable")
            } else if target.is_some() {
                Some("external_target_unavailable")
            } else if external {
                Some("external_target_not_fetched")
            } else {
                Some("external_check_disabled")
            };
            let state = if available {
                ("eligible", "completed", "observed", None)
            } else {
                ("unknown", "not_attempted", "unknown", reason)
            };
            let ptr = format!("/pages/{i}/links/{j}");
            let r = record(
                "observation",
                "external_link",
                &id,
                &disc,
                digest,
                state,
                if available { Some(ptr.clone()) } else { None },
                None,
                if available {
                    Some(json!(status(target.ok_or(E::SemanticMismatch)?)?))
                } else {
                    None
                },
                Some(ptr),
                if available {
                    index.map(|n| format!("/pages/{n}/status"))
                } else {
                    None
                },
            );
            row.add(candidate_id, r, &mut total, &mut observations)?;
        }
    }
    row.compare(
        &manifest[12],
        &coverage[12],
        "observation",
        "external_link",
        None,
        crawl && external && intact,
        wire,
    )?;
    expected_records.extend(row.records);
    if expected_records != *records {
        return Err(E::SemanticMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::edge_source_usable;
    use serde_json::json;

    #[test]
    fn edge_source_usability_includes_pages_without_links() {
        let page = json!({"status":200,"content_type":"text/html","error":null,"blocked_by_robots":false,"extraction_truncated":false,"links":[]});
        assert!(edge_source_usable(&page).unwrap());
        for (field, value) in [
            ("status", json!(null)),
            ("status", json!(404)),
            ("content_type", json!("image/png")),
        ] {
            let mut changed = page.clone();
            changed[field] = value;
            assert!(!edge_source_usable(&changed).unwrap());
        }
    }
}
