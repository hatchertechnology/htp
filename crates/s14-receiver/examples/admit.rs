//! Admit one retained schema-4 report and print its canonical saved summary.
//!
//! Usage: cargo run --locked -p htp-s14-receiver --example admit -- <report.json>
//! The canonical summary bytes go to stdout (byte-identical to the stored
//! `summary_text`); digests and the validator revision go to stderr. Exit
//! status is 1 when admission rejects, after exactly one last stderr line
//! `rejected stage=<inspection|summary|population> error=<InspectionError Debug name>`.
use htp_s14_receiver::admit;
use std::{
    env,
    error::Error,
    fs,
    time::{Duration, Instant},
};

fn main() -> Result<(), Box<dyn Error>> {
    let path = env::args().nth(1).ok_or("supply a retained report path")?;
    let bytes = fs::read(&path)?;
    let admitted = match admit(&bytes, Instant::now() + Duration::from_secs(30)) {
        Ok(admitted) => admitted,
        Err(e) => {
            // Stable contract for the parity pair (design section 5): exactly one
            // last stderr line, then exit 1. The Python side parses it.
            eprintln!("rejected stage={} error={:?}", e.stage.as_str(), e.error);
            std::process::exit(1);
        }
    };
    let summary = admitted.summary;
    let len = summary.canonical.len();
    print!("{}", String::from_utf8(summary.canonical)?);
    eprintln!(
        "validator_revision={} sha256={} bytes={len} source_sha256={} source_bytes={}",
        admitted.validator_revision, summary.sha256, summary.source_sha256, summary.source_bytes
    );
    Ok(())
}
