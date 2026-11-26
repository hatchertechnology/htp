//! Offline conformance entry for the retained producer successor S14 bundle.
//!
//! Pass the producer `fixtures/contracts` directory, or set
//! `S14_SUCCESSOR_CONTRACTS`. There is no default path: the operator supplies
//! the fixture tree. This entry reads local bytes only; it does not contact a
//! service, issue admission authority, or freeze a contract.
use htp_s14_receiver::conformance::{
    ConformanceEvidence, coverage_label, verify_successor_contracts,
};
use std::{env, path::PathBuf, time::Duration};

fn print_evidence(evidence: &ConformanceEvidence) {
    println!(
        "successor_manifest_sha256={}",
        evidence.successor_manifest_sha256
    );
    println!(
        "original_manifest_sha256={}",
        evidence.original_manifest_sha256
    );
    println!("url_corpus_sha256={}", evidence.url_corpus_sha256);
    println!("ingress_vectors_sha256={}", evidence.ingress_vectors_sha256);
    println!(
        "url_version={} url_revision={} url_seed={} url_cases={}",
        evidence.url_corpus.version,
        evidence.url_corpus.revision,
        evidence.url_corpus.seed,
        evidence.url_corpus.cases.len()
    );
    for file in &evidence.files {
        println!(
            "file={}\tbytes={}\tsha256={}\thistorical_label={}\tchecked={}",
            file.path, file.bytes, file.sha256, file.historical_label, file.checked
        );
    }
    for (index, case) in evidence.url_corpus.cases.iter().enumerate() {
        println!(
            "url_case={index}\thistorical_label={}\tdecision={}\tstored={}",
            case.label,
            case.decision.as_str(),
            case.stored
        );
    }
    for case in &evidence.coverage {
        println!(
            "coverage_case={}\tbytes={}\tsha256={}\thistorical_audit={}\taudit={}\tcomplete={}\tunknown={}\tmissing_h1_findings={}\tmissing_h1={}\treported={}",
            case.case,
            case.bytes,
            case.sha256,
            case.historical_audit,
            coverage_label(case.audit),
            case.complete,
            case.unknown,
            case.missing_h1_findings,
            coverage_label(case.missing_h1_coverage),
            case.reported_rules.join(",")
        );
    }
    println!(
        "result=ok successor_files={} accepted={} reference={} reject={} reject_url_profile_idn={} url_cases={} coverage_cases={}",
        evidence.files.len(),
        evidence.label_count("accept"),
        evidence.label_count("reference"),
        evidence.label_count("reject"),
        evidence.label_count("reject_url_profile_idn"),
        evidence.url_corpus.cases.len(),
        evidence.coverage.len()
    );
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let contracts = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .or_else(|| env::var_os("S14_SUCCESSOR_CONTRACTS").map(PathBuf::from))
        .ok_or("supply the producer fixtures/contracts path or set S14_SUCCESSOR_CONTRACTS")?;
    let evidence = verify_successor_contracts(&contracts, Duration::from_secs(30))?;
    println!("contracts={}", contracts.display());
    print_evidence(&evidence);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_counts_are_exact() {
        assert_eq!(htp_s14_receiver::conformance::ACCEPT_COUNT, 10);
        assert_eq!(htp_s14_receiver::conformance::URL_CASE_COUNT, 42);
        assert_eq!(htp_s14_receiver::conformance::SUCCESSOR_FILE_COUNT, 61);
    }
}
