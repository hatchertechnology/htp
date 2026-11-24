//! Offline equality for the producer's replaced S14 legacy findings.
use crate::{InspectionError as E, inspect};
use serde::{Deserialize, Serialize};
use serde_json::{json, value::RawValue};
use sha2::{Digest, Sha256};
use std::time::Instant;

#[derive(Deserialize)]
struct Report<'a> {
    #[serde(borrow)]
    findings: Vec<&'a RawValue>,
}
#[derive(Deserialize, Serialize)]
struct Finding<D> {
    key: String,
    rule: String,
    severity: String,
    url: String,
    evidence: String,
    evidence_items: Vec<String>,
    details: D,
}

#[derive(Deserialize, Serialize)]
struct PolicyDetails {
    classification: String,
}

#[derive(Deserialize, Serialize)]
struct LegacyDetails {
    // The producer always emits this key, even when the status is unknown.
    #[serde(deserialize_with = "Option::<u16>::deserialize")]
    status: Option<u16>,
    bytes: u64,
    ttfb_ms: u64,
    words: u64,
    dom_nodes: u64,
    observation_count: u64,
}
#[derive(Deserialize)]
struct Rule<'a> {
    #[serde(borrow)]
    rule: &'a str,
}

/// Checks the eight producer-replaced populations, eight legacy populations and removed rules.
/// Other legacy findings and downstream summary are outside this check.
///
/// # Errors
/// Returns an inspection error or a mismatch in a checked field.
#[allow(clippy::too_many_lines)]
pub fn check_compatibility_findings(input: &[u8], deadline: Instant) -> Result<(), E> {
    inspect(input, deadline)?;
    let report: Report<'_> = serde_json::from_slice(input).map_err(|_| E::Shape)?;
    let v = crate::projection::project(input)?;
    let pages = v["pages"].as_array().ok_or(E::SemanticMismatch)?;
    let config = &v["policy_guidance"]["config"];
    let seed = url::Url::parse(v["request"]["url"].as_str().ok_or(E::SemanticMismatch)?)
        .map_err(|_| E::Url)?;
    let checked = [
        "short_title",
        "long_title",
        "short_description",
        "long_description",
        "little_content",
        "too_many_links",
        "noindex",
        "http_redirect",
    ];
    let legacy = [
        "deep_page",
        "slow_ttfb",
        "large_image",
        "incorrect_media_type",
        "http_scheme",
        "underscore_url",
        "space_url",
        "multiple_slashes",
    ];
    let removed = [
        "missing_hreflang_xdefault",
        "external_link_broken",
        "external_link_redirect",
        "sitemap_noindex",
        "canonical_to_noindex",
        "hreflang_to_noindex",
        "canonical_to_redirect",
        "hreflang_to_redirect",
    ];
    let mut actual = Vec::new();
    for raw in report.findings {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        let rule: Rule<'_> = serde_json::from_str(raw.get()).map_err(|_| E::Shape)?;
        if removed.contains(&rule.rule) {
            return Err(E::SemanticMismatch);
        }
        if legacy.contains(&rule.rule) {
            let finding: Finding<LegacyDetails> =
                serde_json::from_str(raw.get()).map_err(|_| E::Shape)?;
            actual.push(json!(finding).to_string());
        } else if checked.contains(&rule.rule) {
            let finding: Finding<PolicyDetails> =
                serde_json::from_str(raw.get()).map_err(|_| E::Shape)?;
            actual.push(json!(finding).to_string());
        }
    }
    let mut expected = Vec::new();
    for p in pages {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        let s = |k: &str| p[k].as_str().ok_or(E::SemanticMismatch);
        let b = |k: &str| p[k].as_bool().ok_or(E::SemanticMismatch);
        let address = s("url")?;
        let url = url::Url::parse(address).map_err(|_| E::Url)?;
        let scoped = matches!(url.scheme(), "http" | "https")
            && url.host_str() == seed.host_str()
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && !b("is_resource")?;
        let status = if p["status"].is_null() {
            None
        } else {
            Some(p["status"].as_u64().ok_or(E::SemanticMismatch)?)
        };
        let unavailable = b("blocked_by_robots")?
            || !p["error"].is_null()
            || status.is_none()
            || b("extraction_truncated")?;
        let content = s("content_type")?
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let html = status.is_some_and(|n| (200..300).contains(&n))
            && matches!(
                content.as_str(),
                "text/html" | "application/xhtml+xml" | "application/vnd.wap.xhtml+xml"
            );
        let flags = p["flags"].as_array().ok_or(E::SemanticMismatch)?;
        for rule in legacy {
            let mut items = Vec::new();
            let mut mark = |value: String| {
                if !items.contains(&value) && items.len() < 2000 {
                    items.push(value);
                }
            };
            let number = |field: &str| p[field].as_u64().ok_or(E::SemanticMismatch);
            match rule {
                "deep_page" if number("depth")? > 4 => mark(number("depth")?.to_string()),
                "slow_ttfb" if number("ttfb_ms")? > 800 => {
                    mark(format!("{}ms", number("ttfb_ms")?));
                }
                "large_image"
                    if status.is_some()
                        && s("content_type")?.starts_with("image/")
                        && number("bytes")? > 102_400 =>
                {
                    mark(format!("{} bytes", number("bytes")?));
                }
                "incorrect_media_type"
                    if status == Some(200)
                        && [
                            (".css", "text/css"),
                            (".js", "javascript"),
                            (".jpg", "image/jpeg"),
                            (".jpeg", "image/jpeg"),
                            (".png", "image/png"),
                            (".webp", "image/webp"),
                            (".svg", "image/svg+xml"),
                        ]
                        .iter()
                        .any(|(ext, mime)| {
                            url.path().to_ascii_lowercase().ends_with(ext)
                                && !p["content_type"].as_str().unwrap_or("").contains(mime)
                        }) =>
                {
                    mark(s("content_type")?.to_owned());
                }
                "http_scheme" if url.scheme() == "http" => mark(address.to_owned()),
                "underscore_url" if url.path().contains('_') => mark(url.path().to_owned()),
                "space_url" if url.path().contains("%20") => mark(url.path().to_owned()),
                "multiple_slashes" if url.path().contains("//") => mark(url.path().to_owned()),
                _ => {}
            }
            if html && !b("is_resource")? && flags.iter().any(|v| v.as_str() == Some(rule)) {
                mark(rule.to_owned());
            }
            if !items.is_empty() {
                let key = format!(
                    "{:x}",
                    Sha256::digest(format!("{rule}\n{address}").as_bytes())
                );
                expected.push(json!({"key":key,"rule":rule,"severity": if rule == "incorrect_media_type" {"alert"} else {"warning"},"url":address,"evidence":items[0],"evidence_items":items,"details":{"status":p["status"],"bytes":p["bytes"],"ttfb_ms":p["ttfb_ms"],"words":p["words"],"dom_nodes":p["dom_nodes"],"observation_count":items.len()}}).to_string());
            }
        }
        let mut add = |rule: &str, evidence: String, classification: &str| {
            let key = format!(
                "{:x}",
                Sha256::digest(format!("seosmith-s14-finding-v1\n{rule}\n{address}").as_bytes())
            );
            expected.push(json!({"key": key, "rule":rule, "severity":"warning", "url":address, "evidence":evidence, "evidence_items":[evidence], "details":{"classification":classification}}).to_string());
        };
        if scoped && html && !unavailable {
            for (field, min, max, short, long) in [
                (
                    "title",
                    "title_min",
                    "title_max",
                    "short_title",
                    "long_title",
                ),
                (
                    "description",
                    "description_min",
                    "description_max",
                    "short_description",
                    "long_description",
                ),
            ] {
                let n = s(field)?.chars().count() as u64;
                let lo = config[min].as_u64().ok_or(E::SemanticMismatch)?;
                let hi = config[max].as_u64().ok_or(E::SemanticMismatch)?;
                if n > 0 && n < lo {
                    add(short, format!("{n} characters"), "advisory");
                } else if n > hi {
                    add(long, format!("{n} characters"), "advisory");
                }
            }
            let words = p["words"].as_u64().ok_or(E::SemanticMismatch)?;
            if words < config["words_min"].as_u64().ok_or(E::SemanticMismatch)? {
                add("little_content", format!("{words} words"), "advisory");
            }
            let links = p["links"].as_array().ok_or(E::SemanticMismatch)?.len() as u64;
            if links > config["links_max"].as_u64().ok_or(E::SemanticMismatch)? {
                add("too_many_links", links.to_string(), "advisory");
            }
            if config["require_indexable"]
                .as_bool()
                .ok_or(E::SemanticMismatch)?
                && s("robots")?
                    .split([',', ' ', ';'])
                    .any(|x| x.eq_ignore_ascii_case("noindex") || x.eq_ignore_ascii_case("none"))
            {
                add("noindex", s("robots")?.to_owned(), "policy_violation");
            }
        }
        if scoped
            && !unavailable
            && config["forbid_redirects"]
                .as_bool()
                .ok_or(E::SemanticMismatch)?
            && status.is_some_and(|n| (300..400).contains(&n))
        {
            add(
                "http_redirect",
                status.unwrap_or_default().to_string(),
                "policy_violation",
            );
        }
    }
    actual.sort_unstable();
    expected.sort_unstable();
    if actual != expected {
        return Err(E::SemanticMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod detail_tests {
    use super::*;

    #[test]
    fn nullable_status_is_required_and_unselected_fields_are_skipped() {
        let mut fields = json!({"status":null,"bytes":123,"ttfb_ms":80,"words":0,"dom_nodes":0,"observation_count":1,"extension":{"future":true}});
        let details: LegacyDetails = serde_json::from_value(fields.clone()).unwrap();
        assert_eq!(details.status, None);
        assert!(json!(details).get("extension").is_none());
        fields.as_object_mut().unwrap().remove("status");
        assert!(serde_json::from_value::<LegacyDetails>(fields).is_err());
    }
}
