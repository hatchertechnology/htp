//! Offline inventory of historical positive reports; not an admission test.
use htp_s14_receiver::{
    check_compatibility_findings, check_reconstructed_rules, check_source_bindings, inspect,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::PathBuf,
    time::{Duration, Instant},
};

fn verify_totals(count: usize, failures: usize) -> Result<(), Box<dyn std::error::Error>> {
    if count != 27 || failures != 0 {
        return Err(format!("expected 27 positives; checked {count}, failed {failures}").into());
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_path = PathBuf::from(
        env::args_os()
            .nth(1)
            .ok_or("supply successor manifest path")?,
    );
    let bytes = fs::read(&manifest_path)?;
    let manifest_hash = format!("{:x}", Sha256::digest(&bytes));
    if manifest_hash != "03c31ee3175c1dfc44ef74fdf2ba4fdafc1d7c2f5ed61495d80f9c196eba1a10" {
        return Err("successor manifest hash mismatch".into());
    }
    let manifest: Value = serde_json::from_slice(&bytes)?;
    let base = manifest_path.parent().ok_or("missing parent")?;
    println!("manifest_sha256={manifest_hash}");
    let mut count = 0;
    let mut failures = 0;
    for entry in manifest["files"].as_array().ok_or("missing files")? {
        if entry["semantic_expectation"] != "accept" {
            continue;
        }
        count += 1;
        let path = entry["path"].as_str().ok_or("missing path")?;
        let data = fs::read(base.join(path))?;
        let digest = format!("{:x}", Sha256::digest(&data));
        if entry["sha256"].as_str() != Some(digest.as_str())
            || entry["bytes"].as_u64() != Some(data.len() as u64)
        {
            return Err(format!("fixture integrity mismatch: {path}").into());
        }
        let inspection = inspect(&data, Instant::now() + Duration::from_secs(30)).map(|_| ());
        let rules = check_reconstructed_rules(&data, Instant::now() + Duration::from_secs(30));
        let bindings = check_source_bindings(&data, Instant::now() + Duration::from_secs(30));
        let compatibility =
            check_compatibility_findings(&data, Instant::now() + Duration::from_secs(30));
        if inspection.is_err() || rules.is_err() || bindings.is_err() || compatibility.is_err() {
            failures += 1;
        }
        println!(
            "{path}\t{}\t{digest}\tinspect={inspection:?}\trules={rules:?}\tbindings={bindings:?}	compatibility={compatibility:?}",
            data.len()
        );
    }
    verify_totals(count, failures)
}

#[cfg(test)]
mod tests {
    use super::verify_totals;
    #[test]
    fn positive_results_and_count_gate_exit() {
        assert!(verify_totals(27, 0).is_ok());
        assert!(verify_totals(27, 1).is_err());
        assert!(verify_totals(26, 0).is_err());
    }
}
