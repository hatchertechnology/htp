//! Worst-case-escaping exact-cap schema-4 report, produced by the real serialiser
//! (`finding_coverage_prototype::generate_wire_v1`), same page/finding shape as S2's exact-cap fixture
//! (examples/make_s14_schema4_fixtures.rs `exact_cap`), but the padding characters are chosen to maximise
//! JSON-escape expansion instead of plain `x`.
//!
//!   wc_report <out.json> <mode: x|quote|backslash|ctrl> [target-bytes]
//!
//! `quote` pads with `"` (serialised as the 2-byte `\"`), `backslash` with `\` (`\\`), `ctrl` with U+0001
//! (the 6-byte `\u0001`). A remainder of at most `bytes_per_char - 1` plain `x` fixes the exact length.
//! This file is built inside a COPY of the read-only SEOsmith checkout (run.sh does that); it is not part of it.
use anyhow::{Result, bail, ensure};
use seosmith::{
    finding_coverage_prototype::{fixture_input, generate_wire_v1},
    model::{Page, Report},
    policy::AdvisoryPolicy,
};

const PAGES: usize = 60;
const KEYS: usize = 6;
const MAX_PAD: usize = 15_000;

fn page(url: &str, title: &str) -> Page {
    Page {
        url: url.into(),
        status: Some(200),
        content_type: "text/html".into(),
        encoding: "utf-8".into(),
        language: "en".into(),
        language_source: "html".into(),
        title: title.into(),
        description: "A page description that is long enough to be a description, but not too long for the rules.".into(),
        headings: vec![(1, "A heading".into())],
        bytes: 1024,
        words: 120,
        ..Page::default()
    }
}

fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().collect();
    ensure!(a.len() >= 3, "usage: wc_report <out.json> <x|quote|backslash|ctrl> [target]");
    let (ch, bpc): (char, usize) = match a[2].as_str() {
        "x" => ('x', 1),
        "quote" => ('"', 2),
        "backslash" => ('\\', 2),
        "ctrl" => ('\u{1}', 6),
        m => bail!("mode {m}"),
    };
    let target: usize = a.get(3).map(|s| s.parse()).transpose()?.unwrap_or(4_952_756);
    let policy = AdvisoryPolicy::default();
    // pads[i] = (special chars, plain x chars)
    let build = |pads: &[(usize, usize)]| -> Result<Vec<u8>> {
        let pages = (0..PAGES)
            .map(|i| {
                let mut p = page(
                    &format!("https://example.com/cap/{i:04}"),
                    &format!("A well sized title for cap page {i:04}"),
                );
                for k in 0..KEYS {
                    let (s, x) = pads[i * KEYS + k];
                    let v = format!("{}{}", ch.to_string().repeat(s), "x".repeat(x));
                    p.open_graph.insert(format!("og:pad{k}"), vec![v]);
                }
                p
            })
            .collect();
        let mut report: Report = fixture_input("complete-clean-h1")?;
        report.pages = pages;
        generate_wire_v1(&mut report, &policy)
    };
    let mut pads = vec![(0usize, 0usize); PAGES * KEYS];
    let base = build(&pads)?.len();
    ensure!(base < target, "base report already {base} bytes");
    for _ in 0..6 {
        let len = build(&pads)?.len();
        if len == target {
            std::fs::write(&a[1], build(&pads)?)?;
            return Ok(());
        }
        // bytes still to add (or remove), special chars first, the remainder as plain x
        let mut need = target as i64 - len as i64;
        if need > 0 {
            for p in pads.iter_mut() {
                if need <= 0 { break; }
                let room = MAX_PAD - p.0 - p.1;
                let n = ((need as usize) / bpc).min(room);
                p.0 += n; need -= (n * bpc) as i64;
            }
            if need > 0 && need < bpc as i64 {
                for p in pads.iter_mut() {
                    if need <= 0 { break; }
                    let room = MAX_PAD - p.0 - p.1;
                    let n = (need as usize).min(room);
                    p.1 += n; need -= n as i64;
                }
            }
        } else {
            let mut drop = (-need) as usize;
            for p in pads.iter_mut().rev() {
                if drop == 0 { break; }
                let x = p.1.min(drop); p.1 -= x; drop -= x;
                let n = (drop / bpc + usize::from(drop % bpc != 0)).min(p.0);
                if n > 0 { p.0 -= n; let freed = n * bpc; if freed >= drop { p.1 += freed - drop; drop = 0; } else { drop -= freed; } }
            }
        }
    }
    let bytes = build(&pads)?;
    ensure!(bytes.len() == target, "did not converge: {} vs {target}", bytes.len());
    std::fs::write(&a[1], bytes)?;
    Ok(())
}
