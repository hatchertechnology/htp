//! Receiver for schema-4 reports. `inspect` is bounded structural inspection only.
//! [`admit`] is the schema-4 admission entry point (inspection, saved-summary
//! derivation and full findings-population equality); the legacy
//! `validate_for_admission` stub stays closed. No proof writer, DB adapter,
//! capability, or acceptance authority is implemented here.
mod admission;
mod advisories;
mod bindings;
pub mod budget;
mod compatibility;
pub mod conformance;
mod families;
mod finding_coverage;
mod full_population;
mod projection;
mod raw;
mod reconstruction;
mod remaining;
pub mod roles;
mod saved_summary;
mod shape;
mod wire;

pub use admission::{
    AdmissionError, AdmissionStage, Admitted, VALIDATOR_REVISION, VALIDATOR_REVISION_V2, admit,
};
pub use advisories::check_scalar_advisories;
pub use bindings::check_source_bindings;
pub use compatibility::check_compatibility_findings;
pub use finding_coverage::{
    BatchCoverage, Coverage, FindingCoverage, RuleCoverage, finding_coverage,
    finding_coverage_batch,
};
pub use reconstruction::{ConsistencyEvidence, check_consistency};
pub use remaining::check_reconstructed_rules;
pub use saved_summary::{
    MAX_SAVED_SUMMARY_BYTES, SAVED_SUMMARY_VERSION, SavedSummary, derive_saved_summary,
};
pub use shape::{
    InspectedCandidate, InspectionError, ValidatedS14, admitted_url, inspect,
    validate_for_admission,
};
/// Existing decoded report cap, not an invented lower skeleton limit.
pub const MAX_REPORT_BYTES: usize = 4_952_756;
pub const MAX_DEPTH: usize = 64;
pub const MAX_STRING_BYTES: usize = 16_384;
pub const MAX_POLICY_BYTES: usize = 65_536;
