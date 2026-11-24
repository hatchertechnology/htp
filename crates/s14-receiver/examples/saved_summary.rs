//! Print the canonical schema-4 saved summary for one retained report.
//!
//! Usage: cargo run --offline --locked -p htp-s14-receiver --example `saved_summary` -- <report.json>
//! The canonical JSON is written to stdout; the summary digest/byte count and
//! the exact retained-source digest/byte count to stderr.
use htp_s14_receiver::derive_saved_summary;
use std::{
    env,
    error::Error,
    fs,
    time::{Duration, Instant},
};

fn main() -> Result<(), Box<dyn Error>> {
    let path = env::args().nth(1).ok_or("supply a retained report path")?;
    let bytes = fs::read(&path)?;
    let summary = derive_saved_summary(&bytes, Instant::now() + Duration::from_secs(30))?;
    let bytes = summary.canonical.len();
    print!("{}", String::from_utf8(summary.canonical)?);
    eprintln!(
        "sha256={} bytes={bytes} source_sha256={} source_bytes={}",
        summary.sha256, summary.source_sha256, summary.source_bytes
    );
    Ok(())
}
