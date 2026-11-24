//! Conservative, local verification of a versioned finding-coverage claim.
//!
//! The top-level `finding_coverage` extension is a producer *declaration*. The
//! receiver independently recomputes the pinned audit + policy finding
//! population for the retained pages and compares it, including multiplicity,
//! and independently rebuilds the candidate coverage rows before certifying a
//! per-rule policy or global claim rather than trusting their supplied
//! `complete`/`omitted` labels and counts.
//! An absent extension, an unsupported version, an absent check or an
//! unverifiable prerequisite means the corresponding absence claim is unknown;
//! positive observations always stay visible. A verified `complete` check whose
//! expected population is empty is the only route to a clean rule result, and a
//! globally `complete` audit never implies a globally clean report.
use crate::{InspectionError as E, full_population, inspect, projection};
use serde::Deserialize;
use serde_json::{Value, value::RawValue};
use std::{collections::BTreeSet, time::Instant};

/// Result of verifying one absence claim.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Coverage {
    /// The pinned expected population for the rule/audit was independently
    /// reproduced from retained source and the claim matches.
    CompleteVerified,
    /// No verified complete claim exists; absence is unknown.
    UnknownPartial,
}
/// Verified per-rule coverage plus the verified global audit state.
#[derive(Debug, PartialEq, Eq)]
pub struct FindingCoverage {
    /// Retained observations for the selected rule; never hidden by coverage.
    pub reported_findings: usize,
    /// Per-rule coverage for the requested rule.
    pub coverage: Coverage,
    /// Global population coverage. `CompleteVerified` means the full pinned
    /// population was reproduced, not that the report has no findings.
    pub audit: Coverage,
}
/// Batch verification result for every pinned catalogue rule.
#[derive(Debug, PartialEq, Eq)]
pub struct BatchCoverage {
    /// Verified global audit state. `CompleteVerified` means the full pinned
    /// population was reproduced, not that the report has no findings.
    pub audit: Coverage,
    /// One entry per catalogue rule, in the catalogue's sorted order.
    pub rules: Vec<RuleCoverage>,
}
/// One rule's retained finding count and verified coverage state.
#[derive(Debug, PartialEq, Eq)]
pub struct RuleCoverage {
    pub rule: String,
    pub reported_findings: usize,
    pub coverage: Coverage,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Extension {
    version: u64,
    audit: String,
    checks: Vec<Check>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Check {
    rule_id: String,
    status: String,
}
#[derive(Deserialize)]
struct Report<'a> {
    #[serde(borrow)]
    findings: Vec<&'a RawValue>,
    #[serde(default, deserialize_with = "present_extension")]
    finding_coverage: Option<Extension>,
}
fn present_extension<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Extension>, D::Error> {
    Extension::deserialize(d).map(Some)
}
#[derive(Deserialize)]
struct Rule<'a> {
    #[serde(borrow)]
    rule: &'a str,
}

/// Rules whose expected population depends on other retained pages or edges.
/// Mirrors the pinned producer's `GRAPH_RULES`; every other catalogue rule is
/// treated as item-local. A graph rule is complete only when the retained graph
/// is complete and every required target is observed.
const GRAPH_RULES: &[&str] = &[
    "broken_resource",
    "insecure_resource",
    "external_link_broken",
    "external_link_redirect",
    "external_link",
    "external_target",
    "duplicate_title",
    "duplicate_description",
    "duplicate_content",
    "broken_internal_link",
    "redirect_chain",
    "redirect_loop",
    "orphan_page",
    "mixed_incoming_rel",
    "nofollow_indexable",
    "canonical_to_error",
    "canonical_to_redirect",
    "canonical_to_noindex",
    "canonical_chain",
    "hreflang_return_missing",
    "hreflang_to_error",
    "hreflang_to_redirect",
    "hreflang_to_noindex",
    "hreflang_noncanonical",
    "pagination_not_linked",
];

fn html(p: &Value) -> bool {
    p["status"]
        .as_u64()
        .is_some_and(|s| (200..300).contains(&s))
        && p["content_type"].as_str().is_some_and(|c| {
            matches!(
                c.split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase()
                    .as_str(),
                "text/html" | "application/xhtml+xml" | "application/vnd.wap.xhtml+xml"
            )
        })
}

/// Strict successful-HTML observation used for graph targets and the seed.
fn page_observable(p: &Value) -> bool {
    p["is_resource"].as_bool() == Some(false)
        && p["status"]
            .as_u64()
            .is_some_and(|s| (200..300).contains(&s))
        && html(p)
        && p["extraction_truncated"].as_bool() == Some(false)
        && p["blocked_by_robots"].as_bool() == Some(false)
        && p["error"].is_null()
}

/// Any observed non-resource response (successful HTML or not).
fn page_observed(p: &Value) -> bool {
    p["is_resource"].as_bool() == Some(false)
        && p["status"].as_u64().is_some()
        && p["error"].is_null()
        && p["blocked_by_robots"].as_bool() == Some(false)
}

fn page_target_observed(pages: &[Value], url: &str) -> bool {
    pages
        .iter()
        .any(|t| t["url"].as_str() == Some(url) && page_observable(t))
}

fn resource_target_observed(pages: &[Value], url: &str) -> bool {
    pages.iter().any(|t| {
        t["url"].as_str() == Some(url)
            && t["is_resource"].as_bool() == Some(true)
            && t["status"].as_u64().is_some()
            && t["error"].is_null()
            && t["blocked_by_robots"].as_bool() == Some(false)
    })
}

/// A policy coverage row is complete only when the retained declaration says so
/// and the omitted count is present and exactly zero. A missing or malformed
/// omitted count is never treated as zero.
fn row_complete(row: &Value) -> bool {
    row.get("complete").and_then(Value::as_bool) == Some(true)
        && row.get("omitted").and_then(Value::as_u64) == Some(0)
}

fn coverage_rows(v: &Value) -> Result<&Vec<Value>, E> {
    v["policy_guidance"]["candidate"]["coverage"]
        .as_array()
        .ok_or(E::Shape)
}

/// Item-local prerequisite: retained pages are observed and at least one
/// successful HTML page and the usable seed are present. It deliberately does
/// not require a completed crawl: the claim is scoped to the retained pages and
/// a partial audit still leaves global absence unknown. A truncated 2xx HTML
/// page withholds the claim because item-local extraction may be incomplete.
fn item_sources_adequate(v: &Value, deadline: Instant) -> Result<bool, E> {
    let pages = v["pages"].as_array().ok_or(E::Shape)?;
    let seed = v["request"]["url"].as_str().ok_or(E::Shape)?;
    let mut html_observed = false;
    for p in pages {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        if p["is_resource"].as_bool().ok_or(E::Shape)? {
            continue;
        }
        if !page_observed(p) {
            return Ok(false);
        }
        if html(p) {
            if p["extraction_truncated"].as_bool() != Some(false) {
                return Ok(false);
            }
            html_observed = true;
        }
    }
    Ok(html_observed
        && pages
            .iter()
            .any(|p| p["url"].as_str() == Some(seed) && page_observable(p)))
}

/// Any URL retained twice, or as both a page and a resource, is ambiguous for
/// the retained graph; a graph/global absence claim cannot rely on it.
fn unique_pages(pages: &[Value]) -> Result<bool, E> {
    let mut seen = std::collections::HashSet::new();
    for p in pages {
        let url = p["url"].as_str().ok_or(E::Shape)?;
        if !seen.insert(url.to_owned()) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Graph prerequisite: a completed frontier-exhausted crawl, item sources,
/// unique page identities including the seed, and observed targets for every
/// edge, resource relationship, redirect, canonical and alternate the graph
/// rules consult. Missing or ambiguous targets and unresolved redirects stay
/// unknown. The page-local part is shared with global.
fn graph_sources_adequate(v: &Value, deadline: Instant) -> Result<bool, E> {
    if v["coverage_complete"].as_bool() != Some(true)
        || v["outcome"].as_str() != Some("completed")
        || v["stop_reason"].as_str() != Some("frontier_exhausted")
        || !item_sources_adequate(v, deadline)?
    {
        return Ok(false);
    }
    let pages = v["pages"].as_array().ok_or(E::Shape)?;
    let seed = v["request"]["url"].as_str().ok_or(E::Shape)?;
    let Ok(seed_url) = url::Url::parse(seed) else {
        return Ok(false);
    };
    if !unique_pages(pages)? {
        return Ok(false);
    }
    if !pages
        .iter()
        .any(|p| p["url"].as_str() == Some(seed) && page_observable(p))
    {
        return Ok(false);
    }
    let check_external = v["request"]["check_external_links"].as_bool() == Some(true);
    for p in pages {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        let page_url = p["url"].as_str().ok_or(E::Shape)?;
        // Links are extracted only from successful HTML responses. Redirects,
        // canonicals, alternates and resource relationships are still evaluated
        // on every retained page, including a non-HTML 301 and resources, so a
        // response with no content type cannot hide an unresolved target.
        if p["is_resource"].as_bool() == Some(false) && html(p) {
            for link in p["links"].as_array().ok_or(E::Shape)? {
                let target = link["url"].as_str().ok_or(E::Shape)?;
                let external =
                    url::Url::parse(target).is_ok_and(|u| u.host_str() != seed_url.host_str());
                let observed = page_target_observed(pages, target);
                if external {
                    if !check_external || !observed {
                        return Ok(false);
                    }
                } else if !observed {
                    return Ok(false);
                }
            }
        }
        for relationship in p["relationships"].as_array().ok_or(E::Shape)? {
            if relationship["resource"].as_bool() == Some(true)
                && !resource_target_observed(pages, relationship["url"].as_str().ok_or(E::Shape)?)
            {
                return Ok(false);
            }
        }
        let redirect = p["redirect"]
            .as_str()
            .or_else(|| p["refresh_target"].as_str());
        if let Some(target) = redirect
            && target != page_url
            && !page_target_observed(pages, target)
        {
            return Ok(false);
        }
        if let Some(canonical) = p["canonical"].as_str()
            && canonical != page_url
            && !page_target_observed(pages, canonical)
        {
            return Ok(false);
        }
        for alternate in p["alternates"].as_array().ok_or(E::Shape)? {
            let target = alternate["url"].as_str().ok_or(E::Shape)?;
            if target != page_url && !page_target_observed(pages, target) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// Per-check prerequisite. Every policy row for the rule must be complete; a
/// rule can carry several rows (for example observation and policy-violation
/// `noindex`). Graph rules additionally need the graph prerequisite; item-local
/// rules need only the page-local prerequisite, so a complete local check
/// survives an unrelated partial edge.
fn check_adequate(v: &Value, rule: &str, deadline: Instant) -> Result<bool, E> {
    let rows = coverage_rows(v)?;
    let mut policy_complete = true;
    for row in rows.iter().filter(|r| r["rule_id"] == rule) {
        policy_complete &= row_complete(row);
    }
    if !policy_complete {
        return Ok(false);
    }
    if GRAPH_RULES.contains(&rule) {
        return graph_sources_adequate(v, deadline);
    }
    item_sources_adequate(v, deadline)
}

/// Global prerequisite: the graph prerequisite plus every policy coverage row
/// complete. A complete audit needs both this and full population equality.
fn global_adequate(v: &Value, deadline: Instant) -> Result<bool, E> {
    if !graph_sources_adequate(v, deadline)? {
        return Ok(false);
    }
    Ok(coverage_rows(v)?.iter().all(row_complete))
}

/// True when the pinned policy catalogue defines at least one candidate
/// coverage row for `rule`. This is read from the embedded registry, not the
/// supplied coverage array, so a removed or renamed supplied row cannot decide
/// that no reconstruction is needed. Audit-only catalogue rules have no policy
/// row and rest on the reconstructed finding population instead.
fn policy_rule(rule: &str) -> Result<bool, E> {
    let registry: Value =
        serde_json::from_str(include_str!("registry.json")).map_err(|_| E::Shape)?;
    let rules = registry["manifest_rules"].as_array().ok_or(E::Shape)?;
    Ok(rules.iter().any(|r| r["rule_id"] == rule))
}

/// Validate the extension shape before interpreting absence. Returns `false`
/// when the version is not understood (treated as absent = unknown).
///
/// # Errors
/// Rejects malformed members, unknown rule ids, duplicate/unsorted checks,
/// invalid status strings and a `complete` audit that does not cover the full
/// pinned catalogue.
fn validate_extension(extension: &Extension, catalogue: &[String]) -> Result<bool, E> {
    if extension.version != 1 {
        return Ok(false);
    }
    if !matches!(extension.audit.as_str(), "complete" | "partial")
        || extension.checks.len() > catalogue.len()
        || extension
            .checks
            .iter()
            .any(|c| !matches!(c.status.as_str(), "complete" | "unknown"))
        || extension
            .checks
            .windows(2)
            .any(|w| w[0].rule_id >= w[1].rule_id)
        || extension
            .checks
            .iter()
            .any(|c| catalogue.binary_search(&c.rule_id).is_err())
    {
        return Err(E::Shape);
    }
    // A complete audit must enumerate every catalogue rule as complete; a
    // partial audit may omit checks (omitted = unknown).
    if extension.audit == "complete"
        && (extension.checks.len() != catalogue.len()
            || extension.checks.iter().any(|c| c.status != "complete"))
    {
        return Err(E::Shape);
    }
    Ok(true)
}

fn canonical(finding: &full_population::ExpectedFinding) -> Result<String, E> {
    serde_json::to_string(finding).map_err(|_| E::Shape)
}
fn canonical_all(findings: &[full_population::ExpectedFinding]) -> Result<Vec<String>, E> {
    let mut out = findings
        .iter()
        .map(canonical)
        .collect::<Result<Vec<_>, _>>()?;
    out.sort_unstable();
    Ok(out)
}
fn parse_finding(raw: &str) -> Result<full_population::ExpectedFinding, E> {
    serde_json::from_str(raw).map_err(|_| E::Shape)
}
fn retained_matching(
    report: &Report<'_>,
    rule: &str,
) -> Result<Vec<full_population::ExpectedFinding>, E> {
    report
        .findings
        .iter()
        .filter_map(|raw| {
            serde_json::from_str::<Rule<'_>>(raw.get())
                .ok()
                .filter(|r| r.rule == rule)
                .map(|_| raw)
        })
        .map(|raw| parse_finding(raw.get()))
        .collect()
}
fn expected_for(
    expected: &[full_population::ExpectedFinding],
    rule: &str,
) -> Vec<full_population::ExpectedFinding> {
    expected
        .iter()
        .filter(|f| f.rule == rule)
        .cloned()
        .collect()
}

/// Verifies a v1 `finding_coverage` claim for `rule_id` against the pinned
/// audit + policy population recomputed from retained source.
///
/// Before a claim is certified, the candidate manifest and coverage rows are
/// independently reconstructed from the retained pages and links (reusing
/// `check_consistency` and `check_reconstructed_rules`) rather than trusted
/// from their supplied `complete`/`omitted` labels and counts.
///
/// # Errors
/// Returns inspection errors, a malformed extension (`Shape`), or a `complete`
/// claim contradicted by row reconstruction or population equality
/// (`SemanticMismatch`).
pub fn finding_coverage(
    input: &[u8],
    rule_id: &str,
    deadline: Instant,
) -> Result<FindingCoverage, E> {
    inspect(input, deadline)?;
    let report: Report<'_> = serde_json::from_slice(input).map_err(|_| E::Shape)?;
    let catalogue = full_population::catalogue();
    let extension = match &report.finding_coverage {
        Some(extension) if validate_extension(extension, &catalogue)? => Some(extension),
        _ => None,
    };
    let mut reported_findings = 0usize;
    for raw in &report.findings {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        let rule: Rule<'_> = serde_json::from_str(raw.get()).map_err(|_| E::Shape)?;
        if rule.rule == rule_id {
            reported_findings += 1;
        }
    }
    let mut result = FindingCoverage {
        reported_findings,
        coverage: Coverage::UnknownPartial,
        audit: Coverage::UnknownPartial,
    };
    let Some(extension) = extension else {
        return Ok(result);
    };
    let rule_claimed = extension
        .checks
        .iter()
        .any(|c| c.rule_id == rule_id && c.status == "complete");
    if extension.audit != "complete" && !rule_claimed {
        return Ok(result);
    }
    // Each absence claim needs independent reproduction and its own source
    // prerequisite. Without both the claim stays unverified/unknown.
    // Parse the selected projection once for both prerequisite decisions.
    let projected = projection::project(input)?;
    let rule_adequate = rule_claimed && check_adequate(&projected, rule_id, deadline)?;
    let audit_adequate = extension.audit == "complete" && global_adequate(&projected, deadline)?;
    if !rule_adequate && !audit_adequate {
        return Ok(result);
    }
    // The supplied candidate coverage rows are an unauthenticated producer
    // declaration. Before certifying any claim, independently reconstruct the
    // rows that back it: `check_reconstructed_rules` rebuilds every manifest and
    // coverage row from the retained pages and links, including the 512/128
    // caps and omission states, and `check_consistency` proves the catalog and
    // count arithmetic. A per-rule policy claim additionally needs the pinned
    // policy row set, so a removed or renamed row cannot pass vacuously. An
    // audit-only rule has no policy row and rests on the full-population
    // reconstruction below.
    if audit_adequate || (rule_adequate && policy_rule(rule_id)?) {
        crate::check_consistency(input, deadline)?;
        crate::check_reconstructed_rules(input, deadline)?;
    }
    let expected = full_population::expected_population(input, deadline)?;
    if rule_adequate {
        let retained = retained_matching(&report, rule_id)?;
        if canonical_all(&retained)? != canonical_all(&expected_for(&expected, rule_id))? {
            return Err(E::SemanticMismatch);
        }
        result.coverage = Coverage::CompleteVerified;
    }
    if audit_adequate {
        let retained = report
            .findings
            .iter()
            .map(|raw| parse_finding(raw.get()))
            .collect::<Result<Vec<_>, _>>()?;
        if canonical_all(&retained)? != canonical_all(&expected)? {
            return Err(E::SemanticMismatch);
        }
        result.audit = Coverage::CompleteVerified;
    }
    Ok(result)
}

fn cached_item_adequate(
    projected: &Value,
    deadline: Instant,
    cache: &mut Option<bool>,
) -> Result<bool, E> {
    if let Some(value) = cache {
        return Ok(*value);
    }
    let value = item_sources_adequate(projected, deadline)?;
    *cache = Some(value);
    Ok(value)
}

fn cached_graph_adequate(
    projected: &Value,
    deadline: Instant,
    cache: &mut Option<bool>,
) -> Result<bool, E> {
    if let Some(value) = cache {
        return Ok(*value);
    }
    let value = graph_sources_adequate(projected, deadline)?;
    *cache = Some(value);
    Ok(value)
}

fn policy_rules() -> Result<BTreeSet<String>, E> {
    let registry: Value =
        serde_json::from_str(include_str!("registry.json")).map_err(|_| E::Shape)?;
    registry["manifest_rules"]
        .as_array()
        .ok_or(E::Shape)?
        .iter()
        .map(|rule| rule["rule_id"].as_str().map(str::to_owned).ok_or(E::Shape))
        .collect()
}

fn canonical_selected(
    all: &[full_population::ExpectedFinding],
    indices: &[usize],
) -> Result<Vec<String>, E> {
    let mut out = indices
        .iter()
        .map(|index| canonical(&all[*index]))
        .collect::<Result<Vec<_>, _>>()?;
    out.sort_unstable();
    Ok(out)
}

/// Verifies every pinned catalogue rule in one batch.
///
/// The retained findings are parsed once, the source projection is built once,
/// each source prerequisite is evaluated at most once, and the expected
/// population is reproduced at most once. This avoids rescanning the complete
/// report for each of the 88 rules.
///
/// A rule is `CompleteVerified` only when its extension check is `complete`,
/// its policy rows are complete, its source prerequisite holds, and its
/// retained finding multiset equals the independently reproduced expected
/// multiset. The audit is `CompleteVerified` only when the extension claims a
/// complete audit, the global prerequisite holds, and the complete retained
/// finding multiset equals the expected population. A partial or absent claim
/// remains `UnknownPartial`; a contradicted claim fails closed.
///
/// # Errors
/// Rejects malformed input/extension shapes (`Shape`), deadline expiry
/// (`Deadline`), and contradicted complete claims (`SemanticMismatch`).
#[allow(clippy::too_many_lines)]
pub fn finding_coverage_batch(input: &[u8], deadline: Instant) -> Result<BatchCoverage, E> {
    inspect(input, deadline)?;
    let report: Report<'_> = serde_json::from_slice(input).map_err(|_| E::Shape)?;
    let catalogue = full_population::catalogue();
    let mut reported = vec![0usize; catalogue.len()];
    for finding in &report.findings {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        let rule: Rule<'_> = serde_json::from_str(finding.get()).map_err(|_| E::Shape)?;
        if let Ok(index) = catalogue.binary_search_by(|candidate| candidate.as_str().cmp(rule.rule))
        {
            reported[index] += 1;
        }
    }
    let mut rules = catalogue
        .iter()
        .zip(reported)
        .map(|(rule, reported_findings)| RuleCoverage {
            rule: rule.clone(),
            reported_findings,
            coverage: Coverage::UnknownPartial,
        })
        .collect::<Vec<_>>();
    let mut audit = Coverage::UnknownPartial;
    let Some(extension) = &report.finding_coverage else {
        return Ok(BatchCoverage { audit, rules });
    };
    if !validate_extension(extension, &catalogue)? {
        return Ok(BatchCoverage { audit, rules });
    }
    let mut claimed = vec![false; catalogue.len()];
    for check in &extension.checks {
        if check.status == "complete"
            && let Ok(index) = catalogue.binary_search(&check.rule_id)
        {
            claimed[index] = true;
        }
    }
    let projected = projection::project(input)?;
    let mut row_ok = vec![true; catalogue.len()];
    for row in coverage_rows(&projected)? {
        if let Some(rule) = row.get("rule_id").and_then(Value::as_str)
            && let Ok(index) = catalogue.binary_search_by(|candidate| candidate.as_str().cmp(rule))
        {
            row_ok[index] &= row_complete(row);
        }
    }
    let mut item_cache = None;
    let mut graph_cache = None;
    let audit_adequate = extension.audit == "complete" && global_adequate(&projected, deadline)?;
    if audit_adequate {
        audit = Coverage::CompleteVerified;
    }
    let mut rule_adequate = vec![false; catalogue.len()];
    for (index, rule) in catalogue.iter().enumerate() {
        if !claimed[index] || !row_ok[index] {
            continue;
        }
        rule_adequate[index] = if GRAPH_RULES.contains(&rule.as_str()) {
            cached_graph_adequate(&projected, deadline, &mut graph_cache)?
        } else {
            cached_item_adequate(&projected, deadline, &mut item_cache)?
        };
    }
    if !audit_adequate && !rule_adequate.iter().any(|adequate| *adequate) {
        return Ok(BatchCoverage { audit, rules });
    }
    let policy_rules = policy_rules()?;
    let need_reconstruction = audit_adequate
        || rule_adequate
            .iter()
            .enumerate()
            .any(|(index, adequate)| *adequate && policy_rules.contains(&catalogue[index]));
    if need_reconstruction {
        crate::check_consistency(input, deadline)?;
        crate::check_reconstructed_rules(input, deadline)?;
    }
    let expected = full_population::expected_population(input, deadline)?;
    let mut all_retained = Vec::with_capacity(report.findings.len());
    let mut retained_indices = vec![Vec::new(); catalogue.len()];
    for finding in &report.findings {
        if Instant::now() >= deadline {
            return Err(E::Deadline);
        }
        let parsed = parse_finding(finding.get())?;
        if let Ok(index) =
            catalogue.binary_search_by(|candidate| candidate.as_str().cmp(&parsed.rule))
        {
            retained_indices[index].push(all_retained.len());
        }
        all_retained.push(parsed);
    }
    if audit_adequate && canonical_all(&all_retained)? != canonical_all(&expected)? {
        return Err(E::SemanticMismatch);
    }
    for (index, adequate) in rule_adequate.iter().enumerate() {
        if !*adequate {
            continue;
        }
        if canonical_selected(&all_retained, &retained_indices[index])?
            != canonical_all(&expected_for(&expected, &catalogue[index]))?
        {
            return Err(E::SemanticMismatch);
        }
        rules[index].coverage = Coverage::CompleteVerified;
    }
    Ok(BatchCoverage { audit, rules })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{Duration, Instant};

    fn complete() -> Value {
        projection::project(include_bytes!(
            "../tests/fixtures/s14-finding-coverage-v1/complete-missing-h1.json"
        ))
        .unwrap()
    }
    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(30)
    }
    fn page(url: &str, status: u64, content_type: &str) -> Value {
        json!({
            "url": url,
            "is_resource": false,
            "status": status,
            "error": null,
            "blocked_by_robots": false,
            "extraction_truncated": false,
            "content_type": content_type,
            "links": [],
            "relationships": [],
            "redirect": null,
            "refresh_target": null,
            "canonical": null,
            "alternates": []
        })
    }

    #[test]
    fn non_html_page_targets_are_graph_checked() {
        // Producer parity: a non-HTML 301 is skipped only for extracted links;
        // its redirect, canonical, alternate and resource relationship targets
        // are still checked.
        for field in ["redirect", "canonical", "alternate", "relationship"] {
            let mut v = complete();
            let mut old = page("https://example.com/old", 301, "");
            match field {
                "redirect" => old["redirect"] = json!("https://example.com/unretained"),
                "canonical" => old["canonical"] = json!("https://example.com/unretained"),
                "alternate" => {
                    old["alternates"] = json!([
                        {"language": "fr", "url": "https://example.com/unretained"}
                    ]);
                }
                "relationship" => {
                    old["relationships"] = json!([
                        {"url": "https://example.com/a.css", "resource": true}
                    ]);
                }
                _ => unreachable!(),
            }
            v["pages"].as_array_mut().unwrap().push(old);
            assert!(!graph_sources_adequate(&v, deadline()).unwrap(), "{field}");
        }
    }

    #[test]
    fn non_success_html_links_are_not_graph_edges() {
        // `html()` is status-based, so a 404 text/html response is an observed
        // non-HTML page: its links are not extracted and do not block graph
        // adequacy, matching the pinned producer predicate.
        let mut v = complete();
        let mut gone = page("https://example.com/gone", 404, "text/html");
        gone["links"] = json!([{"url": "https://outside.example/missing"}]);
        v["pages"].as_array_mut().unwrap().push(gone);
        assert!(graph_sources_adequate(&v, deadline()).unwrap());
    }

    #[test]
    fn unresolved_targets_block_graph_adequacy() {
        for field in [
            "redirect",
            "refresh_target",
            "canonical",
            "alternate",
            "relationship",
        ] {
            let mut v = complete();
            {
                let p = &mut v["pages"][0];
                match field {
                    "redirect" => p["redirect"] = json!("https://example.com/unretained"),
                    "refresh_target" => {
                        p["refresh_target"] = json!("https://example.com/unretained");
                    }
                    "canonical" => p["canonical"] = json!("https://example.com/unretained"),
                    "alternate" => {
                        p["alternates"] = json!([
                            {"language": "fr", "url": "https://example.com/unretained"}
                        ]);
                    }
                    "relationship" => {
                        p["relationships"] = json!([
                            {"url": "https://example.com/a.css", "resource": true}
                        ]);
                    }
                    _ => unreachable!(),
                }
            }
            assert!(!graph_sources_adequate(&v, deadline()).unwrap(), "{field}");
        }
    }

    #[test]
    fn observed_extra_page_resolves_an_internal_link() {
        let mut v = complete();
        v["pages"][0]["links"] = json!([{"url": "https://example.com/child"}]);
        v["pages"].as_array_mut().unwrap().push(page(
            "https://example.com/child",
            200,
            "text/html",
        ));
        assert!(graph_sources_adequate(&v, deadline()).unwrap());
    }

    #[test]
    fn duplicate_page_identity_blocks_graph_adequacy() {
        let mut v = complete();
        let duplicate = v["pages"][0].clone();
        v["pages"].as_array_mut().unwrap().push(duplicate);
        assert!(!graph_sources_adequate(&v, deadline()).unwrap());
    }

    #[test]
    fn resource_only_evidence_is_not_item_adequate() {
        let mut v = complete();
        v["pages"][0]["is_resource"] = json!(true);
        assert!(!item_sources_adequate(&v, deadline()).unwrap());
    }
}
