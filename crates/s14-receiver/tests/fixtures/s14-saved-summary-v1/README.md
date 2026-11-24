# S14 saved-summary fixtures (schema 4, summary version 5)

Status: **local-only**. These fixtures are receiver-derived canonical summaries for
retained schema-4 inputs. They are not production acceptance records and do not
open or authorize the receiver route.

Each summary is produced by `derive_saved_summary` after the existing receiver
checks accept the retained source. The canonical bytes are compact UTF-8 JSON and
are capped at 16 KiB (`16_384` bytes). A larger summary is rejected with
`SummaryTooLarge`, never truncated. A non-schema-4 source is rejected with
`UnsupportedSchema`; schema 1/2 keep the existing version-4 adapters.

## Files

| File | Source | Purpose |
| --- | --- | --- |
| `complete-clean-h1.summary-v5.json` | `s14-finding-coverage-v1/complete-clean-h1.json` | Complete audit, clean for `missing_h1`; all 88 rules verified. |
| `complete-missing-h1.summary-v5.json` | `s14-finding-coverage-v1/complete-missing-h1.json` | Complete audit with an observed `missing_h1` finding. |
| `partial-clean-h1.summary-v5.json` | `s14-finding-coverage-v1/partial-clean-h1.json` | Partial audit; 63 rules verified, 25 unknown. |
| `partial-missing-h1.summary-v5.json` | `s14-finding-coverage-v1/partial-missing-h1.json` | Partial audit; all 88 rules unknown, finding remains visible. |
| `v4-candidate-complete.summary-v5.json` | `v4-candidate-complete.json` | No extension; all 88 rules unknown. |
| `v4-candidate-partial.summary-v5.json` | `v4-candidate-partial.json` | No extension; all 88 rules unknown. |
| `v4-candidate-mixed-omitted.summary-v5.json` | `v4-candidate-mixed-omitted.json` | No extension; all 88 rules unknown. |

`manifest.json` pins each source and summary by byte length and SHA-256. The
summary digest is over the exact canonical bytes and is exposed as `sha256:<hex>`
by `SavedSummary`; the same result also carries `source_sha256` (`sha256:<hex>`)
and `source_bytes` for the retained input. The manifest stores bare hex, so add
the `sha256:` prefix before comparing. The source fields are returned beside the
canonical bytes and do not change the committed summary bytes.

## Semantics

- `coverage: complete_verified` means the batch verifier reproduced the pinned
  expected population for that rule and its source prerequisite. It does not mean
  the whole site is clean.
- `coverage: unknown_partial` means no verified complete claim exists. Absence is
  unknown, not clean.
- A retained finding is always reported in `reported_findings` and in the top-level
  finding counts, even when coverage is unknown.
- `crawl_coverage_complete` is recomputed from retained pages. It is not copied
  from the report's `coverage_complete` flag.
- `evaluation_coverage_complete` is true only when the batch audit is
  `complete_verified`. `coverage_complete` is true only when both crawl and
  evaluation coverage are complete.
- `audit_coverage` is `complete_verified` or `unknown_partial`.
- `audit_coverage` is the report-level aggregate. A `complete_verified` audit does
  not imply every rule is `complete_verified`; per-rule `rule_coverage` entries are
  independent claims and can remain `unknown_partial` beside a verified audit.
- The canonical bytes come from the pinned `serde`/`serde_json` serializer
  (declaration-order structs, sorted `BTreeMap` keys); this is not RFC 8785 JCS,
  so reproduce the digest with this serializer or the committed fixture bytes.

## Regenerate and verify

From the repository root:

```sh
cargo run --offline --locked -p htp-s14-receiver --example saved_summary -j1 -- \
  crates/s14-receiver/tests/fixtures/s14-finding-coverage-v1/complete-clean-h1.json
```

The example prints the canonical bytes and `sha256:<hex>` digest. The regression
`cargo test --offline --locked -p htp-s14-receiver -j1 --test saved_summary`
regenerates every manifest entry, byte-compares the canonical summary, checks the
digest and enforces the 16 KiB ceiling. The tests also verify that batch coverage
matches the single-rule path, that complete claims are verified, that partial or
absent claims stay unknown, and that an incomplete policy row is not certified.

## Scope limits

The summary is bounded metadata derived from retained input. It does not establish
source truth, unobserved page coverage, extraction accuracy, authenticity,
website authorization, provenance, production admission or cancellation. The
existing receiver route remains closed.
