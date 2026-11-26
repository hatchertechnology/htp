//! Local resource qualification for one retained ordinary schema-4 report.
//!
//! `admit` runs the full H1 admission (`htp_s14_receiver::admit`: inspection,
//! summary derivation and the findings-population equality) under the 15 s
//! receiver deadline; the M9 gate runs it on `exact-cap.json`.
//!
//! `derive` runs the complete summary-v5 derivation in one process: inspection,
//! source bindings, consistency, reconstructed rules, compatibility findings,
//! batch finding coverage, projection, crawl coverage, record counts, findings
//! summary, canonical serialization and digest. `stages` runs the public checks
//! separately for per-stage diagnostics. The receiver route stays closed.
//!
//! Usage:
//! `cargo run --offline --locked -p htp-s14-receiver --example resource_check -j1 -- admit <report.json>`
//!
//! The example reads cgroup v2 limits and peak usage from its own cgroup. It does
//! not create or change a cgroup; run it under a bounded scope. It applies the
//! planned 25 s global deadline and the 3,500 ms raw/typed/summary stage cap from
//! `htp_s14_receiver::budget`. Output is one `key=value` line per measurement.
use htp_s14_receiver::{
    InspectionError, admit, budget, check_compatibility_findings, check_consistency,
    check_reconstructed_rules, check_source_bindings, derive_saved_summary, finding_coverage_batch,
    inspect,
};
use sha2::{Digest, Sha256};
use std::{
    env,
    error::Error,
    fs,
    path::Path,
    time::{Duration, Instant},
};

/// Receiver deadline for one admission (M9 pass: within 15 s).
const ADMIT_DEADLINE: Duration = Duration::from_secs(15);

type Stage = fn(&[u8], Instant) -> Result<(), InspectionError>;

#[derive(Debug)]
struct CgroupSnapshot {
    path: String,
    memory_max: Option<String>,
    memory_current: Option<String>,
    memory_peak: Option<String>,
    memory_swap_max: Option<String>,
    cpu_max: Option<String>,
    cpu_usage_usec: Option<u64>,
    cpu_nr_throttled: Option<u64>,
    cpu_throttled_usec: Option<u64>,
    pids_max: Option<String>,
    oom_kill: Option<u64>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1);
    let mode = args.next().ok_or("missing mode: admit|derive|stages")?;
    let fixture = args.next().ok_or("missing fixture path")?;
    let bytes = fs::read(&fixture)?;
    let start = Instant::now();
    let global_end = start + budget::GLOBAL;
    let stage_end = global_end.min(start + Duration::from_millis(budget::STAGES_MS[3]));
    let cgroup_start = read_cgroup_snapshot();
    println!("mode={mode}");
    println!("fixture={fixture}");
    println!("source_bytes={}", bytes.len());
    println!("source_sha256={}", sha256_hex(&bytes));
    println!("global_deadline_ms={}", budget::GLOBAL.as_millis());
    println!("stage_deadline_ms={}", budget::STAGES_MS[3]);
    println!(
        "deadline_remaining_us_at_start={}",
        remaining_us(stage_end, start)
    );
    let result = match mode.as_str() {
        "admit" => run_admit(&bytes, start + ADMIT_DEADLINE),
        "derive" => run_derive(&bytes, stage_end),
        "stages" => run_stages(&bytes, stage_end),
        _ => Err(format!("unknown mode {mode}").into()),
    };
    let end = Instant::now();
    println!("elapsed_us={}", end.duration_since(start).as_micros());
    println!(
        "deadline_remaining_us_at_end={}",
        remaining_us(stage_end, end)
    );
    match (&cgroup_start, read_cgroup_snapshot()) {
        (Some(start), Some(end)) => print_cgroup(start, &end),
        (Some(snapshot), None) => print_cgroup(snapshot, snapshot),
        (None, Some(snapshot)) => print_cgroup(&snapshot, &snapshot),
        (None, None) => println!("cgroup=unavailable"),
    }
    match result {
        Ok(()) => {
            println!("result=ok");
            Ok(())
        }
        Err(error) => {
            println!("result=error");
            println!("error={error}");
            Err(error)
        }
    }
}

fn run_admit(bytes: &[u8], deadline: Instant) -> Result<(), Box<dyn Error>> {
    println!("admit_deadline_ms={}", ADMIT_DEADLINE.as_millis());
    let admitted = admit(bytes, deadline)?;
    println!("validator_revision={}", admitted.validator_revision);
    println!("summary_bytes={}", admitted.summary.canonical.len());
    println!("summary_sha256={}", admitted.summary.sha256);
    println!("summary_source_bytes={}", admitted.summary.source_bytes);
    Ok(())
}

fn run_derive(bytes: &[u8], deadline: Instant) -> Result<(), Box<dyn Error>> {
    let summary = derive_saved_summary(bytes, deadline)?;
    println!("summary_bytes={}", summary.canonical.len());
    println!("summary_sha256={}", summary.sha256);
    println!("summary_source_bytes={}", summary.source_bytes);
    println!("summary_source_sha256={}", summary.source_sha256);
    Ok(())
}

fn run_stages(bytes: &[u8], deadline: Instant) -> Result<(), Box<dyn Error>> {
    let stages: [(&str, Stage); 6] = [
        ("inspect", |input, end| inspect(input, end).map(|_| ())),
        ("bindings", check_source_bindings),
        ("consistency", |input, end| {
            check_consistency(input, end).map(|_| ())
        }),
        ("rules", check_reconstructed_rules),
        ("compatibility", check_compatibility_findings),
        ("coverage", |input, end| {
            finding_coverage_batch(input, end).map(|_| ())
        }),
    ];
    let total_start = Instant::now();
    for (name, stage) in stages {
        if Instant::now() >= deadline {
            return Err(format!("stage deadline expired before {name}").into());
        }
        let stage_start = Instant::now();
        stage(bytes, deadline)?;
        println!(
            "stage={name} elapsed_us={}",
            stage_start.elapsed().as_micros()
        );
    }
    println!("stages_total_us={}", total_start.elapsed().as_micros());
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn remaining_us(deadline: Instant, now: Instant) -> u64 {
    deadline.checked_duration_since(now).map_or(0, |left| {
        u64::try_from(left.as_micros()).unwrap_or(u64::MAX)
    })
}

fn read_cgroup_snapshot() -> Option<CgroupSnapshot> {
    let text = fs::read_to_string("/proc/self/cgroup").ok()?;
    let path = text.lines().find_map(|line| line.strip_prefix("0::"))?;
    let dir = Path::new("/sys/fs/cgroup").join(path.trim_start_matches('/'));
    let (cpu_usage_usec, cpu_nr_throttled, cpu_throttled_usec) =
        read_cpu_stat(&dir.join("cpu.stat"))?;
    Some(CgroupSnapshot {
        path: path.to_owned(),
        memory_max: read_trim(&dir.join("memory.max")),
        memory_current: read_trim(&dir.join("memory.current")),
        memory_peak: read_trim(&dir.join("memory.peak")),
        memory_swap_max: read_trim(&dir.join("memory.swap.max")),
        cpu_max: read_trim(&dir.join("cpu.max")),
        cpu_usage_usec,
        cpu_nr_throttled,
        cpu_throttled_usec,
        pids_max: read_trim(&dir.join("pids.max")),
        oom_kill: read_oom_kill(&dir.join("memory.events")),
    })
}

fn read_trim(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_owned())
}

fn read_cpu_stat(path: &Path) -> Option<(Option<u64>, Option<u64>, Option<u64>)> {
    let text = fs::read_to_string(path).ok()?;
    let mut usage = None;
    let mut throttled = None;
    let mut throttled_usec = None;
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let Some(key) = fields.next() else {
            continue;
        };
        let Some(value) = fields.next().and_then(|value| value.parse().ok()) else {
            continue;
        };
        match key {
            "usage_usec" => usage = Some(value),
            "nr_throttled" => throttled = Some(value),
            "throttled_usec" => throttled_usec = Some(value),
            _ => {}
        }
    }
    Some((usage, throttled, throttled_usec))
}

fn read_oom_kill(path: &Path) -> Option<u64> {
    let text = fs::read_to_string(path).ok()?;
    text.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        if fields.next()? == "oom_kill" {
            fields.next()?.parse().ok()
        } else {
            None
        }
    })
}

fn print_cgroup(start: &CgroupSnapshot, end: &CgroupSnapshot) {
    println!("cgroup_path={}", end.path);
    print_opt("cgroup_memory_max", end.memory_max.as_deref());
    print_opt("cgroup_memory_swap_max", end.memory_swap_max.as_deref());
    print_opt("cgroup_cpu_max", end.cpu_max.as_deref());
    print_opt("cgroup_pids_max", end.pids_max.as_deref());
    print_u64(
        "cgroup_memory_peak_start_bytes",
        start
            .memory_peak
            .as_deref()
            .and_then(|value| value.parse().ok()),
    );
    print_u64(
        "cgroup_memory_peak_bytes",
        end.memory_peak
            .as_deref()
            .and_then(|value| value.parse().ok()),
    );
    print_u64(
        "cgroup_memory_current_bytes",
        end.memory_current
            .as_deref()
            .and_then(|value| value.parse().ok()),
    );
    print_delta(
        "cgroup_cpu_usage_usec",
        start.cpu_usage_usec,
        end.cpu_usage_usec,
    );
    print_delta(
        "cgroup_cpu_nr_throttled",
        start.cpu_nr_throttled,
        end.cpu_nr_throttled,
    );
    print_delta(
        "cgroup_cpu_throttled_usec",
        start.cpu_throttled_usec,
        end.cpu_throttled_usec,
    );
    print_delta("cgroup_oom_kill", start.oom_kill, end.oom_kill);
}

fn print_opt(key: &str, value: Option<&str>) {
    match value {
        Some(value) => println!("{key}={value}"),
        None => println!("{key}=unavailable"),
    }
}

fn print_u64(key: &str, value: Option<u64>) {
    match value {
        Some(value) => println!("{key}={value}"),
        None => println!("{key}=unavailable"),
    }
}

fn print_delta(key: &str, start: Option<u64>, end: Option<u64>) {
    match (start, end) {
        (Some(start), Some(end)) => println!("{key}={}", end.saturating_sub(start)),
        _ => println!("{key}=unavailable"),
    }
}
