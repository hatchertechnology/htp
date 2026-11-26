//! Limited consistency checks. This is not an admission validator.
use crate::{InspectionError, inspect};
use serde_json::Value;
use std::{collections::BTreeMap, time::Instant};

/// Evidence of registry equality and internal count consistency only.
/// Source-derived candidates and record predicates have not been verified.
#[derive(Debug)]
pub struct ConsistencyEvidence {
    pub rules_checked: usize,
    pub omitted_records: u64,
}

/// Compare the pinned catalog and manifest rule metadata, and recompute retained
/// record counts. Counts for omitted records are not reconstructed from source.
///
/// # Errors
/// Returns an inspection or consistency error when a checked field disagrees.
pub fn check_consistency(
    input: &[u8],
    deadline: Instant,
) -> Result<ConsistencyEvidence, InspectionError> {
    inspect(input, deadline)?;
    let wire = crate::wire::wire_of(input)?;
    let v: Value = crate::projection::project(input)?;
    let registry: Value =
        serde_json::from_str(include_str!("registry.json")).map_err(|_| InspectionError::Shape)?;
    let g = &v["policy_guidance"];
    if g["catalog"] != registry["catalog"] {
        return Err(InspectionError::SemanticMismatch);
    }
    let manifest = g["manifest"]
        .as_array()
        .ok_or(InspectionError::SemanticMismatch)?;
    let coverage = g["candidate"]["coverage"]
        .as_array()
        .ok_or(InspectionError::SemanticMismatch)?;
    let records = g["candidate"]["records"]
        .as_array()
        .ok_or(InspectionError::SemanticMismatch)?;
    let rules = registry["manifest_rules"]
        .as_array()
        .ok_or(InspectionError::SemanticMismatch)?;
    if manifest.len() != rules.len() || coverage.len() != rules.len() {
        return Err(InspectionError::SemanticMismatch);
    }
    let mut omitted_total = 0;
    for ((m, c), rule) in manifest.iter().zip(coverage).zip(rules) {
        if Instant::now() >= deadline {
            return Err(InspectionError::Deadline);
        }
        for field in ["category", "rule_id", "rule_version", "expected_pointer"] {
            if m.get(field) != rule.get(field) {
                return Err(InspectionError::SemanticMismatch);
            }
        }
        if c["category"] != rule["category"] || c["rule_id"] != rule["rule_id"] {
            return Err(InspectionError::SemanticMismatch);
        }
        let retained: Vec<_> = records
            .iter()
            .filter(|r| r["category"] == rule["category"] && r["rule_id"] == rule["rule_id"])
            .collect();
        let candidates = match wire {
            crate::wire::Wire::V1 => m["candidates"]
                .as_array()
                .ok_or(InspectionError::SemanticMismatch)?
                .len() as u64,
            // Wire-2 rows carry a count; the ids are verified against the pages
            // by `advisories.rs` / `remaining.rs`.
            crate::wire::Wire::V2 => m["candidates_count"]
                .as_u64()
                .ok_or(InspectionError::SemanticMismatch)?,
        };
        let emitted = retained.len() as u64;
        let omitted = candidates
            .checked_sub(emitted)
            .ok_or(InspectionError::SemanticMismatch)?;
        if c["candidates"].as_u64() != Some(candidates)
            || c["emitted"].as_u64() != Some(emitted)
            || c["omitted"].as_u64() != Some(omitted)
        {
            return Err(InspectionError::SemanticMismatch);
        }
        omitted_total += omitted;
        // With omissions, aggregate distributions include unretained records.
        if omitted == 0 {
            for (record_field, coverage_field) in [
                ("eligibility", "eligibility_counts"),
                ("attempt", "attempt_counts"),
                ("outcome", "outcomes"),
            ] {
                let mut counts = BTreeMap::<String, u64>::new();
                for r in &retained {
                    *counts
                        .entry(
                            r[record_field]
                                .as_str()
                                .ok_or(InspectionError::SemanticMismatch)?
                                .to_owned(),
                        )
                        .or_default() += 1;
                }
                if serde_json::to_value(counts).map_err(|_| InspectionError::Shape)?
                    != c[coverage_field]
                {
                    return Err(InspectionError::SemanticMismatch);
                }
            }
        }
    }
    if records.iter().any(|r| {
        !rules
            .iter()
            .any(|rule| r["category"] == rule["category"] && r["rule_id"] == rule["rule_id"])
    }) {
        return Err(InspectionError::SemanticMismatch);
    }
    Ok(ConsistencyEvidence {
        rules_checked: rules.len(),
        omitted_records: omitted_total,
    })
}
