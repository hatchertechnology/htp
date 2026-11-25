//! Schema-4 admission: the single entry point the API calls.
//!
//! A report is admitted iff (1) the saved summary derives, (2) its `findings`,
//! as a multiset of complete finding objects, equal the population the pinned
//! producer would emit for the retained source, (3) a `finding_coverage` claim
//! is not contradicted (checked inside the summary derivation), and (4) an
//! `evidence_contract`, if present, is an object of at most 1 MiB with
//! `version` 1 (checked by `inspect`). The evidence content is opaque here and
//! excluded from the equality.
use crate::{InspectionError, SavedSummary, derive_saved_summary, full_population, inspect};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::time::Instant;

/// The one validator revision. H2 seeds exactly this string in
/// `seosmith_s14_validators`; H3 sends it with every commit.
pub const VALIDATOR_REVISION: &str = "s14-wire-1/full-population-1/evidence-v1";

/// Where admission stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmissionStage {
    /// Byte, JSON, shape or evidence-extension inspection.
    Inspection,
    /// Saved-summary derivation (bindings, consistency, rules, coverage claim).
    Summary,
    /// Full findings-population equality.
    Population,
}

impl AdmissionStage {
    /// Stable lowercase name for the 422 `{stage}` body field.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inspection => "inspection",
            Self::Summary => "summary",
            Self::Population => "population",
        }
    }
}

/// A rejected report: the stage that rejected it and the inspection error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AdmissionError {
    pub stage: AdmissionStage,
    pub error: InspectionError,
}

impl std::fmt::Display for AdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.stage.as_str(), self.error)
    }
}
impl std::error::Error for AdmissionError {}

/// An admitted report. `summary` is exactly what H2 stores as `summary_text`.
#[derive(Debug)]
pub struct Admitted {
    pub summary: SavedSummary,
    pub validator_revision: &'static str,
}

#[derive(Deserialize)]
struct Findings<'a> {
    #[serde(borrow)]
    findings: Vec<&'a RawValue>,
}

/// Multiset equality of `report.findings` with the pinned expected population.
///
/// Each reported finding must deserialize into the exact finding shape (extra
/// properties are rejected) and the sorted canonical forms must be identical.
pub(crate) fn findings_match(input: &[u8], deadline: Instant) -> Result<(), InspectionError> {
    let expected = full_population::expected_population(input, deadline)?;
    let reported: Findings<'_> =
        serde_json::from_slice(input).map_err(|_| InspectionError::Shape)?;
    if reported.findings.len() != expected.len() {
        return Err(InspectionError::SemanticMismatch);
    }
    let mut got = Vec::with_capacity(expected.len());
    for raw in &reported.findings {
        if Instant::now() >= deadline {
            return Err(InspectionError::Deadline);
        }
        let finding: full_population::ExpectedFinding =
            serde_json::from_str(raw.get()).map_err(|_| InspectionError::SemanticMismatch)?;
        got.push(serde_json::to_string(&finding).map_err(|_| InspectionError::Shape)?);
    }
    let mut want = expected
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| InspectionError::Shape)?;
    got.sort_unstable();
    want.sort_unstable();
    if got == want {
        Ok(())
    } else {
        Err(InspectionError::SemanticMismatch)
    }
}

/// Admits one schema-4 report or reports the rejecting stage.
///
/// # Errors
/// [`AdmissionError`] with the stage and the underlying inspection error.
pub fn admit(raw: &[u8], deadline: Instant) -> Result<Admitted, AdmissionError> {
    let fail = |stage, error| AdmissionError { stage, error };
    inspect(raw, deadline).map_err(|e| fail(AdmissionStage::Inspection, e))?;
    let summary =
        derive_saved_summary(raw, deadline).map_err(|e| fail(AdmissionStage::Summary, e))?;
    findings_match(raw, deadline).map_err(|e| fail(AdmissionStage::Population, e))?;
    Ok(Admitted {
        summary,
        validator_revision: VALIDATOR_REVISION,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const FIXTURE: &[u8] =
        include_bytes!("../tests/fixtures/s14-finding-coverage-v1/complete-missing-h1.json");

    fn deadline() -> Instant {
        Instant::now() + std::time::Duration::from_secs(30)
    }

    /// E-r MINOR-4: the evidence exclusion is asserted at the equality level.
    /// Evidence that mimics findings changes neither the expected population
    /// nor the reported findings that `findings_match` compares.
    #[test]
    fn evidence_is_excluded_from_the_population_equality() {
        let mut report: Value = serde_json::from_slice(FIXTURE).unwrap();
        let before = full_population::expected_population(FIXTURE, deadline()).unwrap();
        findings_match(FIXTURE, deadline()).unwrap();
        report["evidence_contract"] = json!({
            "version": 1,
            "findings": report["findings"].clone(),
            "extra": [{"rule": "missing_h1"}],
        });
        let with = serde_json::to_vec(&report).unwrap();
        let after = full_population::expected_population(&with, deadline()).unwrap();
        assert_eq!(before, after, "expected population ignores evidence");
        findings_match(&with, deadline()).expect("equality ignores evidence");
        // And evidence cannot repair a wrong population.
        report["findings"].as_array_mut().unwrap().pop();
        let broken = serde_json::to_vec(&report).unwrap();
        assert_eq!(
            findings_match(&broken, deadline()),
            Err(InspectionError::SemanticMismatch)
        );
    }
}
