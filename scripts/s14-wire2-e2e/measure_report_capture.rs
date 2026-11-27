//! Copied into a detached SEOsmith checkout's examples directory for local measurement.
//! Fetches only HTML pages present in the retained acceptance report, at >=1 s intervals.
use anyhow::{bail, Result};
use seosmith::{families::types::CaptureMode, fetch::{Fetcher, Transport}, local_checkpoint, model::Report};
use std::time::{Duration, Instant};
use url::Url;
#[tokio::main]
async fn main() -> Result<()> {
    let path = std::env::args().nth(1).expect("report path");
    let report: Report = serde_json::from_slice(&std::fs::read(path)?)?;
    if report.request.url.as_str() != "https://www.kerryhatcher.com/" { bail!("unapproved seed"); }
    let fetcher = Fetcher::default();
    let mut times = Vec::new();
    let mut failures = Vec::new();
    for page in report.pages.iter().filter(|p| p.html() && !p.is_resource) {
        let url = Url::parse(&page.url)?;
        if url.scheme() != "https" || url.host_str() != Some("www.kerryhatcher.com") { bail!("unapproved URL"); }
        tokio::time::sleep(Duration::from_millis(1000)).await;
        match fetcher.get(&url).await {
            Ok(response) => {
                let start = Instant::now();
                std::hint::black_box(local_checkpoint::capture_with(&url, page, Some(&response), CaptureMode::Wire2));
                times.push(u64::try_from(start.elapsed().as_micros())?);
            }
            Err(_) => failures.push(url.to_string()),
        }
    }
    times.sort_unstable();
    let p95 = if times.is_empty() { 0 } else { times[(times.len() * 95).div_ceil(100)-1] };
    println!("{}", serde_json::json!({"count":times.len(),"p95_micros":p95,"max_micros":times.last(),"fetch_failures":failures}));
    if !failures.is_empty() || times.is_empty() || p95 > 100_000 { bail!("capture gate failed"); }
    Ok(())
}
