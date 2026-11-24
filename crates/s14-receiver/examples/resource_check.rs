//! Isolated local measurement of one inspection or binding check on a saved report.
use htp_s14_receiver::{check_source_bindings, inspect};
use std::{
    env, fs,
    time::{Duration, Instant},
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let mode = args.next().ok_or("missing mode")?;
    let bytes = fs::read(args.next().ok_or("missing fixture")?)?;
    let start = Instant::now();
    let deadline = start + Duration::from_secs(30);
    match mode.as_str() {
        "inspect" => {
            inspect(&bytes, deadline)?;
        }
        "bindings" => check_source_bindings(&bytes, deadline)?,
        "rules" => htp_s14_receiver::check_reconstructed_rules(&bytes, deadline)?,
        _ => return Err("unknown mode".into()),
    }
    println!(
        "mode={mode} bytes={} elapsed_us={}",
        bytes.len(),
        start.elapsed().as_micros()
    );
    Ok(())
}
