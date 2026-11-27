//! Run inside a scratch SEOsmith checkout as an example, on a downloaded report.
use anyhow::Result;
use seosmith::{model::Report, policy::AdvisoryPolicy, policy_candidate::generate_unvalidated};
fn main() -> Result<()> {
    let path = std::env::args().nth(1).expect("report path");
    let report: Report = serde_json::from_slice(&std::fs::read(path)?)?;
    let (_, rows) = generate_unvalidated(&report, &AdvisoryPolicy::default())?;
    println!("{}", serde_json::to_vec(&rows)?.len());
    Ok(())
}
