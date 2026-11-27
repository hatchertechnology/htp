//! Source reconstruction of the six scalar advisory rows; never admission authority.
use crate::{InspectionError as E, inspect};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Instant};

fn hash(s: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(s.as_bytes()))
}
fn fail<T>() -> Result<T, E> {
    Err(E::SemanticMismatch)
}
fn string<'a>(v: &'a Value, k: &str) -> Result<&'a str, E> {
    v.get(k).and_then(Value::as_str).ok_or(E::SemanticMismatch)
}
fn flag(v: &Value, k: &str) -> Result<bool, E> {
    v.get(k).and_then(Value::as_bool).ok_or(E::SemanticMismatch)
}

/// Verify the six scalar advisory rows against independently enumerated pages.
/// No other rule or admission property is certified.
///
/// # Errors
/// Returns an inspection error or a mismatch in a checked advisory field.
#[allow(clippy::too_many_lines)]
pub fn check_scalar_advisories(input: &[u8], deadline: Instant) -> Result<(), E> {
    inspect(input, deadline)?;
    let wire = crate::wire::wire_of(input)?;
    let v: Value = crate::projection::project(input)?;
    let pages = v["pages"].as_array().ok_or(E::SemanticMismatch)?;
    let g = &v["policy_guidance"];
    let manifest = g["manifest"].as_array().ok_or(E::SemanticMismatch)?;
    let coverage = g["candidate"]["coverage"]
        .as_array()
        .ok_or(E::SemanticMismatch)?;
    let records = g["candidate"]["records"]
        .as_array()
        .ok_or(E::SemanticMismatch)?;
    let seed = url::Url::parse(string(&v["request"], "url")?).map_err(|_| E::Url)?;
    let digest = string(&g["candidate"], "policy_digest")?;
    let crawl_complete = flag(&v, "coverage_complete")?;
    let rules = [
        ("short_title", "title_min", "title"),
        ("long_title", "title_max", "title"),
        ("short_description", "description_min", "description"),
        ("long_description", "description_max", "description"),
        ("little_content", "words_min", "words"),
        ("too_many_links", "links_max", "links"),
    ];
    let mut emitted_global = 0usize;
    for (row, (rule, threshold, field)) in rules.iter().enumerate() {
        let limit = g["config"][threshold].as_u64().ok_or(E::SemanticMismatch)?;
        let mut ids = Vec::new();
        let mut expected_records = Vec::new();
        let mut eligibility = BTreeMap::<&str, u64>::new();
        let mut attempts = BTreeMap::<&str, u64>::new();
        let mut outcomes = BTreeMap::<&str, u64>::new();
        let mut reasons = BTreeMap::<&str, u64>::new();
        let mut omitted = 0u64;
        for (i, p) in pages.iter().enumerate() {
            if Instant::now() >= deadline {
                return Err(E::Deadline);
            }
            let address = string(p, "url")?;
            let resource = flag(p, "is_resource")?;
            let url = url::Url::parse(address).map_err(|_| E::Url)?;
            let in_scope = url.host_str() == seed.host_str()
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none();
            let entity = hash(&format!(
                "seosmith-entity-v1\n{}\n{address}",
                if resource { "resource" } else { "page" }
            ));
            ids.push(entity.clone());
            let status = match p.get("status") {
                Some(Value::Null) => None,
                Some(n) => Some(n.as_u64().ok_or(E::SemanticMismatch)?),
                None => return fail(),
            };
            let error = p.get("error").ok_or(E::SemanticMismatch)?;
            if !error.is_null() && !error.is_string() {
                return fail();
            }
            let unavailable = flag(p, "blocked_by_robots")?
                || !error.is_null()
                || status.is_none()
                || flag(p, "extraction_truncated")?;
            let content = string(p, "content_type")?
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let html = status.is_some_and(|s| (200..300).contains(&s))
                && matches!(
                    content.as_str(),
                    "text/html" | "application/xhtml+xml" | "application/vnd.wap.xhtml+xml"
                );
            let measured = match *field {
                "title" | "description" => string(p, field)?.chars().count() as u64,
                "words" => p[*field].as_u64().ok_or(E::SemanticMismatch)?,
                _ => p[*field].as_array().ok_or(E::SemanticMismatch)?.len() as u64,
            };
            let applicable = in_scope
                && !resource
                && html
                && (!matches!(*field, "title" | "description") || measured > 0);
            let (el, at, out, reason) = if unavailable {
                (
                    "unknown",
                    "not_attempted",
                    "unknown",
                    Some("source_unavailable"),
                )
            } else if !applicable {
                (
                    "ineligible",
                    "not_attempted",
                    "not_applicable",
                    Some("outside_applicability"),
                )
            } else {
                let hit = if matches!(*rule, "long_title" | "long_description" | "too_many_links") {
                    measured > limit
                } else {
                    measured < limit
                };
                (
                    "eligible",
                    "completed",
                    if hit {
                        "advisory_triggered"
                    } else {
                        "advisory_not_triggered"
                    },
                    None,
                )
            };
            *eligibility.entry(el).or_default() += 1;
            *attempts.entry(at).or_default() += 1;
            *outcomes.entry(out).or_default() += 1;
            if out == "unknown" {
                *reasons.entry("source_unavailable").or_default() += 1;
            }
            if emitted_global >= 512 {
                omitted += 1;
                continue;
            }
            emitted_global += 1;
            let record_id = hash(&format!(
                "seosmith-record-v1\nadvisory\n{rule}\ns14-1\n{entity}\nself"
            ));
            expected_records.push(json!({"record_id":record_id,"category":"advisory","rule_id":rule,"rule_version":"s14-1","entity_id":entity,"discriminator":"self","eligibility":el,"attempt":at,"outcome":out,"actual":if at == "completed" {"source"} else {"unavailable"},"source_locator":if at == "completed" {Some(format!("/pages/{i}/{field}"))} else {None},"expected":if at == "completed" {Some(format!("/policy/{threshold}"))} else {None},"confidence":if at == "completed" {"high"} else {"unknown"},"interval_ref":"candidate.observed_at","policy_ref":digest,"reason":reason}));
        }
        let actual_records: Vec<_> = records
            .iter()
            .filter(|r| r["category"] == "advisory" && r["rule_id"] == *rule)
            .cloned()
            .collect();
        let expected_manifest = match wire {
            crate::wire::Wire::V1 => {
                json!({"category":"advisory","rule_id":rule,"rule_version":"s14-1","expected_pointer":format!("/policy/{threshold}"),"candidates":ids})
            }
            crate::wire::Wire::V2 => {
                json!({"category":"advisory","rule_id":rule,"rule_version":"s14-1","expected_pointer":format!("/policy/{threshold}"),"candidates_count":ids.len(),"candidates_digest":crate::wire::candidates_digest(&ids)})
            }
        };
        let expected_coverage = json!({"category":"advisory","rule_id":rule,"candidates":pages.len(),"emitted":expected_records.len(),"omitted":omitted,"omission_reason":if omitted > 0 {Some("record_limit")} else {None},"complete":crawl_complete && omitted == 0 && !outcomes.contains_key("unknown"),"eligibility_counts":eligibility,"attempt_counts":attempts,"outcomes":outcomes,"unknown_reasons":reasons});
        if manifest.get(row) != Some(&expected_manifest)
            || coverage.get(row) != Some(&expected_coverage)
            || actual_records != expected_records
        {
            return fail();
        }
    }
    Ok(())
}
