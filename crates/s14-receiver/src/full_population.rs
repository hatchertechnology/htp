//! Full pinned expected finding population for schema-4 coverage.
//!
//! This module independently reconstructs the producer's `audit::analyze`
//! population and the subsequent `policy::apply` population from retained
//! pages, request scope and policy configuration. It deliberately never reads
//! `report.findings`, so a supplied finding list cannot certify itself.
//!
//! The reconstruction covers every pinned audit rule, including the rules that
//! are driven by retained HTML flags, the duplicate title/description/content
//! aggregation, the redirect graph, resource relationships, alternates and
//! canonical targets. It also reproduces the policy's replaced and removed
//! populations, severity, key derivation, ordered de-duplicated evidence
//! (including the 2000-item cap), detail fields and multiplicity.
//!
//! The result is only the expected population. Whether the retained source is
//! complete enough to establish a clean or complete audit is a separate
//! applicability decision owned by the receiver integration.

use crate::InspectionError as E;
use language_tags::LanguageTag;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    time::Instant,
};
use url::Url;

/// One finding the pinned producer would have emitted for the retained source.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ExpectedFinding {
    pub key: String,
    pub rule: String,
    pub severity: String,
    pub url: String,
    pub evidence: String,
    pub evidence_items: Vec<String>,
    pub details: Value,
}

/// Pinned audit rules and their serialized severities. The list is the exact
/// `audit::rules()` catalogue; order is not semantically meaningful.
const AUDIT_RULES: &[(&str, &str)] = &[
    ("invalid_language", "warning"),
    ("invalid_hreflang", "alert"),
    ("invalid_json_ld", "alert"),
    ("meta_refresh", "warning"),
    ("broken_resource", "alert"),
    ("insecure_resource", "warning"),
    ("encoding_errors", "warning"),
    ("http_redirect", "warning"),
    ("http_client_error", "critical"),
    ("http_server_error", "critical"),
    ("fetch_error", "critical"),
    ("external_link_broken", "alert"),
    ("external_link_redirect", "warning"),
    ("large_image", "warning"),
    ("incorrect_media_type", "alert"),
    ("robots_blocked", "warning"),
    ("missing_title", "alert"),
    ("short_title", "warning"),
    ("long_title", "warning"),
    ("missing_description", "alert"),
    ("short_description", "warning"),
    ("long_description", "warning"),
    ("multiple_title_tags", "alert"),
    ("multiple_description_tags", "alert"),
    ("noindex", "warning"),
    ("nosnippet", "warning"),
    ("noimageindex", "warning"),
    ("missing_h1", "alert"),
    ("heading_order", "warning"),
    ("missing_language", "warning"),
    ("little_content", "warning"),
    ("missing_image_alt", "alert"),
    ("long_image_alt", "warning"),
    ("image_without_size", "warning"),
    ("picture_without_img", "alert"),
    ("duplicate_ids", "alert"),
    ("large_dom", "warning"),
    ("missing_viewport", "alert"),
    ("meta_in_body", "warning"),
    ("form_on_http", "critical"),
    ("insecure_form", "critical"),
    ("missing_hsts", "warning"),
    ("missing_csp", "warning"),
    ("missing_nosniff", "warning"),
    ("http_scheme", "warning"),
    ("http_links", "warning"),
    ("localhost_links", "alert"),
    ("underscore_url", "warning"),
    ("space_url", "warning"),
    ("multiple_slashes", "warning"),
    ("slow_ttfb", "warning"),
    ("deep_page", "warning"),
    ("too_many_links", "warning"),
    ("deadend", "warning"),
    ("internal_nofollow", "warning"),
    ("multiple_canonicals", "alert"),
    ("relative_canonical", "warning"),
    ("canonical_mismatch", "alert"),
    ("sitemap_noindex", "alert"),
    ("sitemap_blocked", "alert"),
    ("sitemap_noncanonical", "alert"),
    ("duplicate_title", "alert"),
    ("duplicate_description", "alert"),
    ("duplicate_content", "alert"),
    ("broken_internal_link", "critical"),
    ("redirect_chain", "alert"),
    ("redirect_loop", "critical"),
    ("orphan_page", "alert"),
    ("mixed_incoming_rel", "warning"),
    ("nofollow_indexable", "warning"),
    ("canonical_to_error", "alert"),
    ("canonical_to_redirect", "alert"),
    ("canonical_to_noindex", "alert"),
    ("canonical_chain", "alert"),
    ("missing_hreflang_xdefault", "warning"),
    ("missing_hreflang_self", "alert"),
    ("hreflang_language_mismatch", "alert"),
    ("relative_hreflang", "warning"),
    ("hreflang_return_missing", "alert"),
    ("hreflang_to_error", "alert"),
    ("hreflang_to_redirect", "alert"),
    ("hreflang_to_noindex", "alert"),
    ("hreflang_noncanonical", "alert"),
    ("hreflang_multiple_languages", "alert"),
    ("pagination_not_linked", "alert"),
];

/// Policy catalogue entries that are not audit rules.
const POLICY_ONLY_RULES: &[&str] = &["alternates_observed", "external_link", "external_target"];

/// Rules whose complete population is replaced by the policy pass.
const POLICY_REPLACED: &[&str] = &[
    "short_title",
    "long_title",
    "short_description",
    "long_description",
    "little_content",
    "too_many_links",
    "noindex",
    "http_redirect",
    "missing_hreflang_xdefault",
];

/// Rules the policy pass removes unconditionally.
const POLICY_REMOVED: &[&str] = &[
    "external_link_broken",
    "external_link_redirect",
    "sitemap_noindex",
    "canonical_to_noindex",
    "hreflang_to_noindex",
    "canonical_to_redirect",
    "hreflang_to_redirect",
];

/// Rules the policy pass removes when the finding URL is outside request scope.
const POLICY_OUT_OF_SCOPE: &[&str] = &[
    "fetch_error",
    "http_client_error",
    "http_server_error",
    "robots_blocked",
    "sitemap_blocked",
];

/// Sorted, unique union of the pinned audit and policy catalogue.
#[must_use]
pub(crate) fn catalogue() -> Vec<String> {
    let mut ids: BTreeSet<String> = AUDIT_RULES.iter().map(|(id, _)| (*id).to_owned()).collect();
    ids.extend(POLICY_ONLY_RULES.iter().map(|id| (*id).to_owned()));
    ids.into_iter().collect()
}

/// Reconstruct the complete pinned audit+policy expected finding population.
///
/// The supplied `report.findings` are never read. Structural absence or misuse
/// of a field the pinned population reads is reported as
/// [`E::SemanticMismatch`]; deadline expiry is reported as [`E::Deadline`].
///
/// # Errors
/// Returns the receiver's inspection errors, `SemanticMismatch` for a missing or
/// malformed field used by the population, or `Deadline` after expiry.
pub(crate) fn expected_population(
    input: &[u8],
    deadline: Instant,
) -> Result<Vec<ExpectedFinding>, E> {
    crate::inspect(input, deadline)?;
    let report: Report = serde_json::from_slice(input).map_err(|_| E::SemanticMismatch)?;
    let seed = Url::parse(&report.request.url).map_err(|_| E::SemanticMismatch)?;
    let mut expected = audit_population(&report.pages, &seed, deadline)?;
    expected.retain(|finding| keep_audit_finding(finding, &seed));
    policy_population(
        &mut expected,
        &report.pages,
        &seed,
        &report.policy_guidance.config,
        deadline,
    )?;
    Ok(expected)
}

#[derive(Deserialize)]
struct Report {
    request: Request,
    pages: Vec<Page>,
    policy_guidance: Guidance,
}

#[derive(Deserialize)]
struct Request {
    url: String,
}

#[derive(Deserialize)]
struct Guidance {
    config: Policy,
}

#[derive(Deserialize)]
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

/// A nullable field that still requires its key to be present on the wire.
///
/// The pinned producer always serializes these keys, using JSON null when the
/// value is absent. A missing key is not producer-emitted and must not be
/// silently read as null, because that would turn unknown into clean.
#[derive(Clone, Debug, Deserialize)]
struct Nullable<T>(Option<T>);

impl<T> Nullable<T> {
    fn is_none(&self) -> bool {
        self.0.is_none()
    }

    fn is_some(&self) -> bool {
        self.0.is_some()
    }

    fn as_ref(&self) -> Option<&T> {
        self.0.as_ref()
    }

    fn as_deref(&self) -> Option<&<T as std::ops::Deref>::Target>
    where
        T: std::ops::Deref,
    {
        self.0.as_deref()
    }

    fn is_some_and<F>(&self, predicate: F) -> bool
    where
        F: FnOnce(&T) -> bool,
    {
        self.0.as_ref().is_some_and(predicate)
    }

    fn filter<F>(&self, predicate: F) -> Option<&T>
    where
        F: FnOnce(&T) -> bool,
    {
        self.0.as_ref().filter(|value| predicate(value))
    }
}

#[derive(Deserialize)]
#[allow(clippy::struct_excessive_bools)] // Independent facts in the retained page contract.
struct Page {
    url: String,
    depth: u64,
    in_sitemap: bool,
    status: Nullable<u16>,
    error: Nullable<String>,
    blocked_by_robots: bool,
    content_type: String,
    bytes: u64,
    ttfb_ms: u64,
    title: String,
    description: String,
    language: String,
    robots: String,
    canonical: Nullable<String>,
    header_canonical: Nullable<String>,
    redirect: Nullable<String>,
    headings: Vec<(u8, String)>,
    links: Vec<Link>,
    images: Vec<Image>,
    alternates: Vec<Alternate>,
    body_hash: String,
    words: u64,
    dom_nodes: u64,
    flags: Vec<String>,
    is_resource: bool,
    refresh_delay: Nullable<f64>,
    refresh_target: Nullable<String>,
    relationships: Vec<Relationship>,
    structured_data: Vec<StructuredData>,
    extraction_truncated: bool,
}

#[derive(Deserialize)]
struct Link {
    url: String,
    nofollow: bool,
}

#[derive(Deserialize)]
struct Image {
    alt: Nullable<String>,
    width: bool,
    height: bool,
}

#[derive(Deserialize)]
struct Alternate {
    language: String,
    url: String,
}

#[derive(Deserialize)]
struct Relationship {
    url: String,
    resource: bool,
}

#[derive(Deserialize)]
struct StructuredData {
    format: String,
    error: Nullable<String>,
}

fn tick(deadline: Instant) -> Result<(), E> {
    if Instant::now() >= deadline {
        Err(E::Deadline)
    } else {
        Ok(())
    }
}

fn rule_severity(rule: &str) -> Option<&'static str> {
    AUDIT_RULES
        .iter()
        .find(|(id, _)| *id == rule)
        .map(|(_, severity)| *severity)
}

fn audit_digest(rule: &str, url: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{rule}\n{url}").as_bytes()))
}

fn policy_digest(rule: &str, url: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("seosmith-s14-finding-v1\n{rule}\n{url}").as_bytes())
    )
}

fn valid_language(value: &str) -> bool {
    LanguageTag::parse(value).is_ok_and(|tag| tag.validate().is_ok())
}

fn html(page: &Page) -> bool {
    page.status
        .is_some_and(|status| (200..300).contains(status))
        && matches!(
            page.content_type
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "text/html" | "application/xhtml+xml" | "application/vnd.wap.xhtml+xml"
        )
}

fn noindex(page: &Page) -> bool {
    page.robots
        .split([',', ' ', ';'])
        .any(|value| value.eq_ignore_ascii_case("noindex") || value.eq_ignore_ascii_case("none"))
}

fn redirect_target(page: &Page) -> Option<&str> {
    page.redirect.as_deref().or(page.refresh_target.as_deref())
}

fn source_unavailable(page: &Page) -> bool {
    page.blocked_by_robots
        || page.error.is_some()
        || page.status.is_none()
        || page.extraction_truncated
}

fn in_scope(seed: &Url, url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http")
        && url.host_str() == seed.host_str()
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn mark(found: &mut BTreeMap<String, Vec<String>>, rule: &str, evidence: String) {
    let values = found.entry(rule.to_owned()).or_default();
    if !values.contains(&evidence) && values.len() < 2000 {
        values.push(evidence);
    }
}

#[allow(clippy::too_many_lines)]
fn audit_population(
    pages: &[Page],
    seed: &Url,
    deadline: Instant,
) -> Result<Vec<ExpectedFinding>, E> {
    let by_url: HashMap<&str, &Page> = pages.iter().map(|page| (page.url.as_str(), page)).collect();
    let mut groups: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    let mut incoming: HashMap<&str, (usize, usize)> = HashMap::new();
    for page in pages {
        tick(deadline)?;
        if html(page) && !page.is_resource {
            for (kind, value) in [
                ("duplicate_title", page.title.as_str()),
                ("duplicate_description", page.description.as_str()),
                ("duplicate_content", page.body_hash.as_str()),
            ] {
                if !value.is_empty() && (kind != "duplicate_content" || page.words > 0) {
                    *groups.entry((kind, value)).or_default() += 1;
                }
            }
        }
        for link in page.links.iter().filter(|_| !page.is_resource) {
            let count = incoming.entry(link.url.as_str()).or_default();
            if link.nofollow {
                count.1 += 1;
            } else {
                count.0 += 1;
            }
        }
    }

    let mut out = Vec::new();
    for page in pages {
        tick(deadline)?;
        let mut found: BTreeMap<String, Vec<String>> = BTreeMap::new();

        if page.blocked_by_robots {
            mark(
                &mut found,
                "robots_blocked",
                "Not fetched: robots.txt".into(),
            );
            if page.in_sitemap {
                mark(
                    &mut found,
                    "sitemap_blocked",
                    "URL listed in sitemap".into(),
                );
            }
        }
        if let Some(error) = page.error.as_ref() {
            mark(&mut found, "fetch_error", error.clone());
        }
        if let Some(code) = page.status.as_ref().copied() {
            if (300..400).contains(&code) {
                mark(&mut found, "http_redirect", code.to_string());
            }
            if (400..500).contains(&code) {
                mark(&mut found, "http_client_error", code.to_string());
            }
            if page.content_type.starts_with("image/") && page.bytes > 102_400 {
                mark(&mut found, "large_image", format!("{} bytes", page.bytes));
            }
            if let Ok(url) = Url::parse(&page.url) {
                let path = url.path().to_ascii_lowercase();
                let expected = [
                    (".css", "text/css"),
                    (".js", "javascript"),
                    (".jpg", "image/jpeg"),
                    (".jpeg", "image/jpeg"),
                    (".png", "image/png"),
                    (".webp", "image/webp"),
                    (".svg", "image/svg+xml"),
                ];
                if code == 200
                    && expected.iter().any(|(extension, mime)| {
                        path.ends_with(extension) && !page.content_type.contains(mime)
                    })
                {
                    mark(
                        &mut found,
                        "incorrect_media_type",
                        page.content_type.clone(),
                    );
                }
            }
            if code >= 500 {
                mark(&mut found, "http_server_error", code.to_string());
            }
        }
        if let Ok(url) = Url::parse(&page.url) {
            if url.scheme() == "http" {
                mark(&mut found, "http_scheme", page.url.clone());
            }
            if url.path().contains('_') {
                mark(&mut found, "underscore_url", url.path().into());
            }
            if url.path().contains("%20") {
                mark(&mut found, "space_url", url.path().into());
            }
            if url.path().contains("//") {
                mark(&mut found, "multiple_slashes", url.path().into());
            }
        }
        if page.ttfb_ms > 800 {
            mark(&mut found, "slow_ttfb", format!("{}ms", page.ttfb_ms));
        }
        if page.depth > 4 {
            mark(&mut found, "deep_page", page.depth.to_string());
        }
        for relationship in &page.relationships {
            if relationship.resource {
                if page.url.starts_with("https:") && relationship.url.starts_with("http:") {
                    mark(&mut found, "insecure_resource", relationship.url.clone());
                }
                if by_url
                    .get(relationship.url.as_str())
                    .is_some_and(|target| target.status.is_some_and(|status| *status >= 400))
                {
                    mark(&mut found, "broken_resource", relationship.url.clone());
                }
            }
        }
        if html(page) && !page.is_resource {
            if !page.language.is_empty() && !valid_language(&page.language) {
                mark(&mut found, "invalid_language", page.language.clone());
            }
            for alternate in &page.alternates {
                if !alternate.language.eq_ignore_ascii_case("x-default")
                    && !valid_language(&alternate.language)
                {
                    mark(&mut found, "invalid_hreflang", alternate.language.clone());
                }
            }
            for (index, block) in page.structured_data.iter().enumerate() {
                if block.format == "json_ld"
                    && let Some(error) = block
                        .error
                        .as_ref()
                        .filter(|error| error.as_str() != "block_limit")
                {
                    mark(
                        &mut found,
                        "invalid_json_ld",
                        format!("block {index}: {error}"),
                    );
                }
            }
            if let Some(delay) = page.refresh_delay.as_ref() {
                mark(
                    &mut found,
                    "meta_refresh",
                    format!(
                        "{delay}s: {}",
                        page.refresh_target.as_deref().unwrap_or("reload")
                    ),
                );
            }
            for flag in &page.flags {
                if rule_severity(flag).is_some() {
                    mark(&mut found, flag, flag.clone());
                }
            }
            for (value, missing, short, long, min, max) in [
                (
                    &page.title,
                    "missing_title",
                    "short_title",
                    "long_title",
                    15,
                    60,
                ),
                (
                    &page.description,
                    "missing_description",
                    "short_description",
                    "long_description",
                    50,
                    160,
                ),
            ] {
                let count = value.chars().count();
                if count == 0 {
                    mark(&mut found, missing, "Empty".into());
                } else if count < min {
                    mark(&mut found, short, format!("{count} characters"));
                } else if count > max {
                    mark(&mut found, long, format!("{count} characters"));
                }
            }
            if page.language.is_empty() {
                mark(
                    &mut found,
                    "missing_language",
                    "Empty lang attribute".into(),
                );
            }
            if !page
                .headings
                .iter()
                .any(|(level, title)| *level == 1 && !title.is_empty())
            {
                mark(&mut found, "missing_h1", "No nonempty H1".into());
            }
            if page
                .headings
                .windows(2)
                .any(|window| window[1].0 > window[0].0 + 1)
            {
                mark(&mut found, "heading_order", "Skipped heading level".into());
            }
            if page.words < 100 {
                mark(
                    &mut found,
                    "little_content",
                    format!("{} words", page.words),
                );
            }
            if page.dom_nodes > 1500 {
                mark(&mut found, "large_dom", page.dom_nodes.to_string());
            }
            if page.images.iter().any(|image| image.alt.is_none()) {
                mark(
                    &mut found,
                    "missing_image_alt",
                    "Missing alt; empty decorative alt is allowed".into(),
                );
            }
            if page.images.iter().any(|image| {
                image
                    .alt
                    .as_ref()
                    .is_some_and(|alt| alt.chars().count() > 125)
            }) {
                mark(
                    &mut found,
                    "long_image_alt",
                    "Alt exceeds 125 characters".into(),
                );
            }
            if page
                .images
                .iter()
                .any(|image| !image.width || !image.height)
            {
                mark(
                    &mut found,
                    "image_without_size",
                    "Width or height missing".into(),
                );
            }
            if noindex(page) {
                mark(&mut found, "noindex", page.robots.clone());
                if page.in_sitemap {
                    mark(&mut found, "sitemap_noindex", page.robots.clone());
                }
            }
            for (directive, rule) in [("nosnippet", "nosnippet"), ("noimageindex", "noimageindex")]
            {
                if page
                    .robots
                    .to_ascii_lowercase()
                    .split([',', ' ', ';'])
                    .any(|value| value == directive)
                {
                    mark(&mut found, rule, page.robots.clone());
                }
            }
            if page.links.is_empty() {
                mark(&mut found, "deadend", "No navigational links".into());
            }
            if page.links.len() > 200 {
                mark(&mut found, "too_many_links", page.links.len().to_string());
            }
            for link in &page.links {
                tick(deadline)?;
                if let Ok(url) = Url::parse(&link.url) {
                    if page.url.starts_with("https:") && url.scheme() == "http" {
                        mark(&mut found, "http_links", link.url.clone());
                    }
                    if matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
                        mark(&mut found, "localhost_links", link.url.clone());
                    }
                    if url.host_str() == seed.host_str() && link.nofollow {
                        mark(&mut found, "internal_nofollow", link.url.clone());
                    }
                }
                if let Some(target) = by_url.get(link.url.as_str()) {
                    let external =
                        Url::parse(&link.url).is_ok_and(|url| url.host_str() != seed.host_str());
                    if target.status.is_some_and(|status| *status >= 400) {
                        mark(
                            &mut found,
                            if external {
                                "external_link_broken"
                            } else {
                                "broken_internal_link"
                            },
                            link.url.clone(),
                        );
                    }
                    if external
                        && target
                            .status
                            .is_some_and(|status| (300..400).contains(status))
                    {
                        mark(&mut found, "external_link_redirect", link.url.clone());
                    }
                    if link.nofollow && html(target) && !noindex(target) {
                        mark(&mut found, "nofollow_indexable", link.url.clone());
                    }
                }
            }
            for (kind, value) in [
                ("duplicate_title", page.title.as_str()),
                ("duplicate_description", page.description.as_str()),
                ("duplicate_content", page.body_hash.as_str()),
            ] {
                if groups.get(&(kind, value)).is_some_and(|count| *count > 1) {
                    mark(&mut found, kind, "Shared by multiple observed pages".into());
                }
            }
            if page.in_sitemap
                && page.url != seed.as_str()
                && !incoming.contains_key(page.url.as_str())
            {
                mark(
                    &mut found,
                    "orphan_page",
                    "No incoming links within observed crawl".into(),
                );
            }
            if incoming
                .get(page.url.as_str())
                .is_some_and(|(follow, nofollow)| *follow > 0 && *nofollow > 0)
            {
                mark(
                    &mut found,
                    "mixed_incoming_rel",
                    "Both follow and nofollow incoming links".into(),
                );
            }
            if let Some(canonical) = page.canonical.as_ref() {
                if page.in_sitemap && canonical != &page.url {
                    mark(&mut found, "sitemap_noncanonical", canonical.clone());
                }
                if page
                    .header_canonical
                    .as_ref()
                    .is_some_and(|header| header != canonical)
                {
                    mark(&mut found, "canonical_mismatch", canonical.clone());
                }
                if let Some(target) = by_url.get(canonical.as_str()) {
                    if target.status.is_some_and(|status| *status >= 400) {
                        mark(&mut found, "canonical_to_error", canonical.clone());
                    }
                    if target
                        .status
                        .is_some_and(|status| (300..400).contains(status))
                    {
                        mark(&mut found, "canonical_to_redirect", canonical.clone());
                    }
                    if noindex(target) {
                        mark(&mut found, "canonical_to_noindex", canonical.clone());
                    }
                    if target
                        .canonical
                        .as_ref()
                        .is_some_and(|target_canonical| target_canonical != canonical)
                    {
                        mark(&mut found, "canonical_chain", canonical.clone());
                    }
                }
            }
            if !page.alternates.is_empty() {
                if !page
                    .alternates
                    .iter()
                    .any(|alternate| alternate.language == "x-default")
                {
                    mark(
                        &mut found,
                        "missing_hreflang_xdefault",
                        "No x-default alternate".into(),
                    );
                }
                if !page
                    .alternates
                    .iter()
                    .any(|alternate| alternate.url == page.url)
                {
                    mark(
                        &mut found,
                        "missing_hreflang_self",
                        "No self alternate".into(),
                    );
                }
                let mut languages: HashMap<&str, BTreeSet<&str>> = HashMap::new();
                for alternate in &page.alternates {
                    tick(deadline)?;
                    languages
                        .entry(&alternate.url)
                        .or_default()
                        .insert(&alternate.language);
                    if alternate.url == page.url
                        && alternate.language != "x-default"
                        && !alternate.language.eq_ignore_ascii_case(&page.language)
                    {
                        mark(
                            &mut found,
                            "hreflang_language_mismatch",
                            alternate.language.clone(),
                        );
                    }
                    if let Some(target) = by_url.get(alternate.url.as_str()) {
                        if target.status.is_some_and(|status| *status >= 400) {
                            mark(&mut found, "hreflang_to_error", alternate.url.clone());
                        }
                        if target
                            .status
                            .is_some_and(|status| (300..400).contains(status))
                        {
                            mark(&mut found, "hreflang_to_redirect", alternate.url.clone());
                        }
                        if noindex(target) {
                            mark(&mut found, "hreflang_to_noindex", alternate.url.clone());
                        }
                        if target
                            .canonical
                            .as_ref()
                            .is_some_and(|canonical| canonical != &target.url)
                        {
                            mark(&mut found, "hreflang_noncanonical", alternate.url.clone());
                        }
                        if html(target)
                            && !target
                                .alternates
                                .iter()
                                .any(|target_alternate| target_alternate.url == page.url)
                        {
                            mark(&mut found, "hreflang_return_missing", alternate.url.clone());
                        }
                    }
                }
                if languages
                    .values()
                    .any(|labels| labels.iter().filter(|label| **label != "x-default").count() > 1)
                {
                    mark(
                        &mut found,
                        "hreflang_multiple_languages",
                        "Alternate has multiple language labels".into(),
                    );
                }
            }
        }
        if let Some(target) = redirect_target(page) {
            if by_url
                .get(target)
                .is_some_and(|redirect| redirect_target(redirect).is_some())
            {
                mark(&mut found, "redirect_chain", target.into());
            }
            let mut visited = HashSet::new();
            visited.insert(page.url.as_str());
            let mut next = Some(target);
            while let Some(url) = next {
                tick(deadline)?;
                if !visited.insert(url) {
                    mark(&mut found, "redirect_loop", url.into());
                    break;
                }
                next = by_url
                    .get(url)
                    .and_then(|redirect| redirect_target(redirect));
            }
        }

        for (rule, items) in found {
            if let Some(severity) = rule_severity(&rule) {
                let observation_count = items.len();
                let evidence = items.first().cloned().unwrap_or_default();
                out.push(ExpectedFinding {
                    key: audit_digest(&rule, &page.url),
                    rule,
                    severity: severity.to_owned(),
                    url: page.url.clone(),
                    evidence,
                    evidence_items: items,
                    details: json!({
                        "status": page.status.as_ref(),
                        "bytes": page.bytes,
                        "ttfb_ms": page.ttfb_ms,
                        "words": page.words,
                        "dom_nodes": page.dom_nodes,
                        "observation_count": observation_count,
                    }),
                });
            }
        }
    }
    out.sort_by(|left, right| (&left.url, &left.rule).cmp(&(&right.url, &right.rule)));
    Ok(out)
}

fn keep_audit_finding(finding: &ExpectedFinding, seed: &Url) -> bool {
    if POLICY_REPLACED.contains(&finding.rule.as_str())
        || POLICY_REMOVED.contains(&finding.rule.as_str())
    {
        return false;
    }
    if POLICY_OUT_OF_SCOPE.contains(&finding.rule.as_str())
        && Url::parse(&finding.url).is_ok_and(|url| !in_scope(seed, &url))
    {
        return false;
    }
    true
}

fn policy_add(
    out: &mut Vec<ExpectedFinding>,
    page: &Page,
    rule: &str,
    evidence: String,
    classification: &str,
) {
    out.push(ExpectedFinding {
        key: policy_digest(rule, &page.url),
        rule: rule.to_owned(),
        severity: "warning".to_owned(),
        url: page.url.clone(),
        evidence: evidence.clone(),
        evidence_items: vec![evidence],
        details: json!({"classification": classification}),
    });
}

fn policy_population(
    out: &mut Vec<ExpectedFinding>,
    pages: &[Page],
    seed: &Url,
    policy: &Policy,
    deadline: Instant,
) -> Result<(), E> {
    for page in pages {
        tick(deadline)?;
        let scoped =
            Url::parse(&page.url).is_ok_and(|url| in_scope(seed, &url)) && !page.is_resource;
        if scoped
            && html(page)
            && !page.is_resource
            && !page.extraction_truncated
            && page.error.is_none()
            && !page.blocked_by_robots
        {
            for (value, min, max, short, long) in [
                (
                    &page.title,
                    policy.title_min,
                    policy.title_max,
                    "short_title",
                    "long_title",
                ),
                (
                    &page.description,
                    policy.description_min,
                    policy.description_max,
                    "short_description",
                    "long_description",
                ),
            ] {
                let count = value.chars().count() as u64;
                if count > 0 && count < min {
                    policy_add(out, page, short, format!("{count} characters"), "advisory");
                } else if count > max {
                    policy_add(out, page, long, format!("{count} characters"), "advisory");
                }
            }
            if page.words < policy.words_min {
                policy_add(
                    out,
                    page,
                    "little_content",
                    format!("{} words", page.words),
                    "advisory",
                );
            }
            if page.links.len() as u64 > policy.links_max {
                policy_add(
                    out,
                    page,
                    "too_many_links",
                    page.links.len().to_string(),
                    "advisory",
                );
            }
            if policy.require_indexable && noindex(page) {
                policy_add(
                    out,
                    page,
                    "noindex",
                    page.robots.clone(),
                    "policy_violation",
                );
            }
        }
        if scoped
            && !source_unavailable(page)
            && policy.forbid_redirects
            && let Some(status) = page.status.filter(|status| (300..400).contains(status))
        {
            policy_add(
                out,
                page,
                "http_redirect",
                status.to_string(),
                "policy_violation",
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn population(bytes: &[u8]) -> Vec<ExpectedFinding> {
        expected_population(bytes, Instant::now() + Duration::from_secs(30))
            .expect("expected population")
    }

    fn canonical(findings: &[ExpectedFinding]) -> Vec<String> {
        let mut values: Vec<String> = findings
            .iter()
            .map(|finding| serde_json::to_string(finding).expect("serialize finding"))
            .collect();
        values.sort_unstable();
        values
    }

    fn reported(bytes: &[u8]) -> Vec<ExpectedFinding> {
        let report: serde_json::Value = serde_json::from_slice(bytes).expect("report");
        report["findings"]
            .as_array()
            .expect("findings")
            .iter()
            .map(|finding| serde_json::from_value(finding.clone()).expect("finding"))
            .collect()
    }

    #[test]
    fn population_matches_paired_producer_fixtures() {
        for bytes in [
            include_str!("../tests/fixtures/s14-finding-coverage-v1/complete-clean-h1.json")
                .as_bytes(),
            include_str!("../tests/fixtures/s14-finding-coverage-v1/complete-missing-h1.json")
                .as_bytes(),
            include_str!("../tests/fixtures/s14-finding-coverage-v1/partial-clean-h1.json")
                .as_bytes(),
            include_str!("../tests/fixtures/s14-finding-coverage-v1/partial-missing-h1.json")
                .as_bytes(),
        ] {
            assert_eq!(
                canonical(&population(bytes)),
                canonical(&reported(bytes)),
                "population mismatch"
            );
        }
    }

    #[test]
    fn supplied_findings_are_not_trusted() {
        let bytes =
            include_bytes!("../tests/fixtures/s14-finding-coverage-v1/complete-missing-h1.json");
        let original = population(bytes);
        let mut report: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        report["findings"] = serde_json::json!([]);
        let mutated = serde_json::to_vec(&report).unwrap();
        assert_eq!(original, population(&mutated));
        report["findings"] = serde_json::json!([{"key":"forged","rule":"missing_h1","severity":"warning","url":"https://example.com/","evidence":"forged","evidence_items":["forged"],"details":{}}]);
        let mutated = serde_json::to_vec(&report).unwrap();
        assert_eq!(original, population(&mutated));
    }

    #[test]
    fn nullable_page_keys_are_required() {
        let bytes =
            include_bytes!("../tests/fixtures/s14-finding-coverage-v1/complete-missing-h1.json");
        for key in [
            "status",
            "error",
            "canonical",
            "header_canonical",
            "redirect",
            "refresh_delay",
            "refresh_target",
        ] {
            let mut report: serde_json::Value = serde_json::from_slice(bytes).unwrap();
            report["pages"][0].as_object_mut().unwrap().remove(key);
            let mutated = serde_json::to_vec(&report).unwrap();
            assert_eq!(
                expected_population(&mutated, Instant::now() + Duration::from_secs(30)),
                Err(crate::InspectionError::SemanticMismatch),
                "missing nullable key {key} must not read as null"
            );
        }
    }

    #[test]
    fn structural_absence_is_rejected() {
        let bytes =
            include_bytes!("../tests/fixtures/s14-finding-coverage-v1/complete-missing-h1.json");
        let mut report: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        report["pages"][0].as_object_mut().unwrap().remove("flags");
        let mutated = serde_json::to_vec(&report).unwrap();
        assert_eq!(
            expected_population(&mutated, Instant::now() + Duration::from_secs(30)),
            Err(crate::InspectionError::SemanticMismatch)
        );
    }

    #[test]
    fn catalogue_matches_paired_producer_catalogue() {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/s14-finding-coverage-v1/catalogue-v1.json"
        ))
        .expect("catalogue");
        let rules: Vec<String> = value["rules"]
            .as_array()
            .expect("rules")
            .iter()
            .map(|rule| rule.as_str().expect("rule id").to_owned())
            .collect();
        assert_eq!(catalogue(), rules);
    }
}
