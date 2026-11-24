//! Offline source scope, manifest digest, and interval binding checks.
use crate::{InspectionError as E, inspect};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fmt::Write, time::Instant};

fn digest(s: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(s.as_bytes()))
}
fn tagged(out: &mut String, key: &str, value: &str) {
    writeln!(out, "{key}={}:{}", value.len(), value).expect("String writes cannot fail");
}
#[derive(Deserialize)]
struct BindingReport {
    request: BindingRequest,
    policy_guidance: BindingGuidance,
    started_at: String,
    finished_at: String,
}
#[derive(Deserialize)]
struct BindingRequest {
    website_id: String,
    binding_generation: u64,
}
#[derive(Deserialize)]
struct BindingGuidance {
    candidate: BindingCandidate,
    manifest: Vec<ManifestRow>,
}
#[derive(Deserialize)]
struct BindingCandidate {
    scope_digest: String,
    manifest_digest: String,
    observed_at: BindingInterval,
}
#[derive(Deserialize)]
struct BindingInterval {
    started_at: String,
    finished_at: String,
}
#[derive(Deserialize)]
struct ManifestRow {
    category: String,
    rule_id: String,
    rule_version: String,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    expected_pointer: Option<String>,
}

fn number(b: &[u8]) -> Result<u32, E> {
    if b.iter().all(u8::is_ascii_digit) {
        Ok(b.iter().fold(0, |n, c| n * 10 + u32::from(c - b'0')))
    } else {
        Err(E::SemanticMismatch)
    }
}

// Whole UTC seconds and exact fractional digits (compared as zero-padded decimal).
fn timestamp(timestamp_text: &str) -> Result<(i64, String), E> {
    let b = timestamp_text.as_bytes();
    if b.len() < 20
        || b.len() > 64
        || !b.is_ascii()
        || b[4] != b'-'
        || b[7] != b'-'
        || !matches!(b[10], b'T' | b't')
        || b[13] != b':'
        || b[16] != b':'
    {
        return Err(E::SemanticMismatch);
    }
    let year = number(&b[0..4])?;
    let month = number(&b[5..7])?;
    let day = number(&b[8..10])?;
    if year == 0 {
        return Err(E::SemanticMismatch);
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let lengths = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&month) || day == 0 || day > lengths[(month - 1) as usize] {
        return Err(E::SemanticMismatch);
    }
    let prior = year - 1;
    let days = prior * 365 + prior / 4 - prior / 100
        + prior / 400
        + lengths[..(month - 1) as usize].iter().sum::<u32>()
        + day;
    let hour = number(&b[11..13])?;
    let minute = number(&b[14..16])?;
    let second = number(&b[17..19])?;
    if hour > 23 || minute > 59 || second > 59 {
        return Err(E::SemanticMismatch);
    }
    let mut pos = 19;
    let mut fraction = String::new();
    if b.get(pos) == Some(&b'.') {
        pos += 1;
        let start = pos;
        while b.get(pos).is_some_and(u8::is_ascii_digit) {
            pos += 1;
        }
        if pos == start {
            return Err(E::SemanticMismatch);
        }
        fraction.push_str(&timestamp_text[start..pos]);
    }
    let offset = match b.get(pos..) {
        Some([b'Z' | b'z']) => 0,
        Some([sign @ (b'+' | b'-'), h1, h2, b':', m1, m2]) => {
            let offset_hours = number(&[*h1, *h2])?;
            let offset_minutes = number(&[*m1, *m2])?;
            if offset_hours > 23 || offset_minutes > 59 {
                return Err(E::SemanticMismatch);
            }
            let offset_seconds = i64::from(offset_hours * 3600 + offset_minutes * 60);
            if *sign == b'-' {
                -offset_seconds
            } else {
                offset_seconds
            }
        }
        _ => return Err(E::SemanticMismatch),
    };
    let seconds = i64::from(days) * 86400 + i64::from(hour * 3600 + minute * 60 + second) - offset;
    fraction.extend(std::iter::repeat_n('0', 64 - fraction.len()));
    Ok((seconds, fraction))
}

/// Independently compare scope and manifest digests and validate inherited interval.
/// Scope binds declared website and generation only; it does not authorize either.
///
/// # Errors
/// Returns an inspection error or a mismatch in the checked bindings.
pub fn check_source_bindings(input: &[u8], deadline: Instant) -> Result<(), E> {
    inspect(input, deadline)?;
    let v: BindingReport = serde_json::from_slice(input).map_err(|_| E::Shape)?;
    let c = &v.policy_guidance.candidate;
    let mut scope = String::from("seosmith-scope-v1\n");
    tagged(&mut scope, "website_id", &v.request.website_id);
    tagged(
        &mut scope,
        "binding_generation",
        &v.request.binding_generation.to_string(),
    );
    if c.scope_digest != digest(&scope) {
        return Err(E::SemanticMismatch);
    }
    let mut rows: Vec<_> = v
        .policy_guidance
        .manifest
        .iter()
        .map(|r| {
            (
                r.category.as_str(),
                r.rule_id.as_str(),
                r.rule_version.as_str(),
                r.expected_pointer.as_deref(),
            )
        })
        .collect();
    rows.sort_unstable();
    let mut encoded = format!("seosmith-manifest-v1\nrows={}\n", rows.len());
    for (category, rule, version, pointer) in rows {
        tagged(&mut encoded, "category", category);
        tagged(&mut encoded, "rule_id", rule);
        tagged(&mut encoded, "rule_version", version);
        tagged(
            &mut encoded,
            "expected_type",
            if pointer.is_some() { "pointer" } else { "null" },
        );
        tagged(&mut encoded, "expected", pointer.unwrap_or(""));
    }
    encoded.push_str("end\n");
    if c.manifest_digest != digest(&encoded) {
        return Err(E::SemanticMismatch);
    }
    let start = &v.started_at;
    let end = &v.finished_at;
    if c.observed_at.started_at != *start
        || c.observed_at.finished_at != *end
        || timestamp(start)? > timestamp(end)?
    {
        return Err(E::SemanticMismatch);
    }
    Ok(())
}
