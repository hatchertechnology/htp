# ADR 0001: Bounded inline evidence transport for the Seosmith pilot

- **Status:** Proposed (Wave 0 design gate). Design only: no code, schema, or deployment change.
- **Tracking:** HTP #19 (H14, "Design bounded artifact storage and atomic report delivery"). #19 stays open until the Wave 2 selected-transport and pilot checks pass.
- **Related:** SEOsmith #1 (S01 observation/evaluation contract v2), HTP #6 (H01 versioned receiver), HTP #5 (full research and sources), HTP #26 (primary bundle).
- **Date:** 2026-11-16

## Context

Seosmith (the crawler) delivers one JSON report per run to HTP. HTP stores it as an immutable audit row. The v1 pipeline is verified in the current tree (`origin/main` at `82999d5`):

- **Exact-byte cap.** `ingest_seosmith_audit` and `import_seosmith_audit` reject `octet_length(report_json) > 16777216` (`supabase/migrations/20261101054016_seosmith_expanded_evidence.sql`, ingest function, around line 84; `supabase/migrations/20261031053413_seosmith_history.sql`, import function). The API repeats the check before the RPC (`apps/api/src/seosmith.rs:51` for worker ingest, `:98` for import).
- **Record budgets.** `seosmith_summary` rejects more than 40,000 pages, more than 400,000 findings, or more than 20,000 pages with `is_resource` set or unset (`supabase/migrations/20261101060006_seosmith_policy_exclusions.sql`, lines 28-48). Explicit request budgets are limited to 1-20,000 pages and 0-20,000 resources.
- **Request body.** The Seosmith routes use `DefaultBodyLimit::max(32 MiB)` (`apps/api/src/seosmith.rs:25,33`). This is envelope overhead for a JSON-escaped string, not a larger report allowance.
- **Schema gate.** `schema_version` must equal `1` in both RPCs and in `seosmith_summary`. v2 is rejected today. This is the intended receiver-first gate.
- **Immutability.** Insert computes the summary through the `seosmith_immutable_audit` trigger. Update is rejected (`supabase/migrations/20261031053413_seosmith_history.sql`, lines 35-43).

S01 v2 (`seosmith/docs/contracts/s01-v2.md`, current on-disk text, "Frozen extension v1") adds `evidence_contract` inside a report whose original bytes are retained. Its bounds are: 128 observations, 512 evaluations, and a compact extension of at most 1,048,576 bytes, all inside the existing 16,777,216-byte report cap.

The Wave 0 question is whether the pilot can carry v2 evidence inline, or whether a chunk or object protocol is needed first. This ADR answers that for the pilot and records the requirements for a later protocol.

## Decision

1. **Pilot transport is bounded inline.** A report is one JSON envelope with a `report_json` string (`delivery_id`, `sha256`, `report_json`), sent in a single HTTP request. There is no chunk, object, or artifact upload in the pilot.
2. **The 16 MiB exact-report byte cap is retained.** The limit is `octet_length(report_json) <= 16,777,216` in UTF-8, checked at the API and in the database. No body-limit increase is part of this decision.
3. **The record budgets are retained:** 20,000 pages, 20,000 resources, 40,000 combined page and resource records, and 400,000 findings. Each is checked in SQL.
4. **The S01 v2 extension budget sits inside the 16 MiB cap.** The producer must keep base report bytes plus extension bytes at or below 16,777,216. Because the extension can reach 1,048,576 bytes, the base report must stay at or below 15,728,640 bytes when the extension is at its maximum. If the total does not fit, finalization fails. It must never emit a silently partial or legacy result. The operator reduces crawl limits and resubmits under a new request ID.
5. **Receiver-side enforcement mirrors the producer.** HTP must enforce the extension limits (128 observations, 512 evaluations, 1,048,576 bytes) in SQL. It must not trust the producer's own counts.
6. **No screenshot, object, chunk, or artifact capability is advertised** until a later protocol ships and is verified. The receiver's capability advertisement must not list one.
7. **Object or chunk storage is deferred, not rejected.** Section "Future protocol requirements" lists what a later protocol must satisfy. Whether Wave 2 needs it is decided from pilot measurements (section "Pilot exit criteria"), not assumed here.

## Bounds

| Limit | Value | Where enforced today | Status |
|---|---|---|---|
| Exact report bytes (UTF-8 octets of `report_json`) | 16,777,216 | API (`seosmith.rs:51`, `:98`); SQL ingest and import | Enforced |
| Pages, including resources | 40,000 combined | SQL `seosmith_summary` (060006 line 33) | Enforced |
| Pages (non-resource) | 20,000 | SQL (060006 lines 47-48) | Enforced |
| Resources | 20,000 | SQL (060006 lines 47-48) | Enforced |
| Findings | 400,000 | SQL (060006 line 33) | Enforced |
| Explicit `max_pages` / `max_resources` | 1-20,000 / 0-20,000 | SQL (060006 line 53) | Enforced |
| HTTP route body | 32 MiB | `apps/api/src/seosmith.rs:25,33` | Enforced; allowance for escaped envelope only |
| v2 extension: observations | 128 | None (no v2 validator yet) | Required in H01 |
| v2 extension: evaluations | 512 | None | Required in H01 |
| v2 extension: compact bytes | 1,048,576 | None | Required in H01 |
| v2 string fields: engine/ruleset ≤128 bytes, timestamps ≤64 bytes, seed ≤16,384 bytes, finding keys exactly 64 lowercase hex | per S01 | None | Required in H01 |

## Serialization and amplification bounds for v2

- **Bounded before serialization.** S01 builds metadata from source JSON pointers and bounded scalar strings, with per-rule aggregates. It does not build a page-by-rule vector. Coverage counts all observed entities, even when their metadata is omitted, and records the omission as `contract_limit`.
- **Validation order (receiver).** Check the exact-byte cap first. Parse once. Then check schema fields, record counts, extension size, and per-field bounds. Compute the summary last. Reject before any insert.
- **Duplicate JSON keys must be rejected for v2.** PostgreSQL `jsonb` keeps only the last value of a duplicated key (per PostgreSQL's JSON-type documentation; not reproduced in this session). The digest is over raw bytes, but derived evidence comes from `jsonb`. Rejecting duplicates keeps parsed evidence identical to the exact bytes.
- **Nesting depth.** I found no nesting-depth check in the migrations. H01 must define one before parse, and the pilot must include a deep-nesting negative fixture.
- **Summary must accept schema 2 before any v2 insert.** The insert trigger calls `seosmith_summary`, which raises on any `schema_version` other than 1. Enabling v2 without updating the summary function fails every v2 insert. This ordering is part of rollout.

### Existing read-path amplification (verified in migrations)

- **Summaries are not cached for legacy rows.** History and detail reads reuse the stored summary only when `summary_version` matches the current version (`'3'` in 060006 lines 96 and 111). Otherwise they call `seosmith_summary(report)` again. Because the immutability trigger forbids updates, older rows are recomputed on every read. A history page can recompute up to 100 summaries (`p_limit` maximum, line 88 onward), and each recomputation makes several full passes over the stored report's pages and findings.
- **Detail returns the report twice.** `seosmith_audit_detail` returns both the parsed `report` (jsonb) and `raw_report_json` (text). For a near-cap report, one detail response carries roughly two copies of the document.

Required before the pilot:

- A derived summary cache. Write it through a definer function into a separate table keyed by `delivery_id` and summary version. Do not update immutable audit rows.
- History returns compact summary fields only. The full extension stays out of list responses.
- Detail-response size is measured at the pilot's largest report. Whether `report` remains in the default detail response is decided from that measurement.

## Exact-byte digest, ownership, binding generation, and idempotent receipt

These properties already hold for worker ingest (`ingest_seosmith_audit`, 054016 ingest function). They are retained unchanged:

1. **Exact bytes.** `p_sha256` must equal the SHA-256 of `convert_to(p_report_json, 'UTF8')`. The raw text is stored in `raw_report_json`, and the digest is the receipt.
2. **Ownership.** The bearer token's SHA-256 selects an enabled `seosmith_bindings` row. The website row is locked `FOR SHARE`. The FQDN must match the report's request URL.
3. **Binding generation.** `request.binding_generation` must equal the binding's `generation`. `request.website_id` must match the binding. `request.request_id` must equal `delivery_id`.
4. **Idempotency.** A transaction-scoped advisory lock keyed on `delivery_id` serializes concurrent deliveries. A duplicate with the same digest and website returns the same receipt. A different digest or website raises `delivery_conflict` (SQLSTATE 23505).
5. **Atomic receipt.** The row insert and the returned receipt come from one RPC call. A receipt is returned only after commit.

Gaps to resolve in H01 (none block the pilot):

- The duplicate response is identical to a first acceptance (`accepted: true`). An additive `duplicate` boolean would let operators distinguish them. This changes the wire envelope, so it needs a deliberate decision.
- The owner import path (`import_seosmith_audit`) takes its delivery identity from `request.request_id` in the report body and does not use bindings. The same delivery ID can therefore be accepted via worker and import with the same bytes and recorded under the first `ingestion_source`. This is acceptable but should be documented.

## Future protocol requirements (not for the pilot, not advertised)

A chunk or object protocol must satisfy all of these before it is used:

- **Session ownership.** A session is created with a binding token and bound to `delivery_id`, binding generation, and website. Sessions expire after a fixed time-to-live.
- **Manifest.** Declares total bytes, chunk count, per-chunk SHA-256 of exact bytes, and a whole-report SHA-256.
- **Idempotent chunk put.** The same index with the same digest is accepted. The same index with a different digest is a conflict (409).
- **No partial visibility.** Chunks are not readable as reports before finalization.
- **Atomic finalization.** One transaction checks chunk count, lengths, ordering, and whole-report digest, then inserts the immutable row and receipt. The assembled report is subject to the same 16 MiB cap and the same record budgets.
- **No client-supplied URLs.** Storage locations are server-generated. No public bucket.
- **Artifacts.** Screenshots and imported artifacts have their own size limits, content-type checks, and retention. They are not mixed into the report row.

## Incomplete uploads, retention, and storage monitoring

- **Pilot (inline).** A request either commits or does not. There is no partial state. A client retry with the same delivery ID and bytes is idempotent.
- **Future chunk protocol.** Expired sessions are garbage-collected. Orphan chunks and the age of the oldest incomplete session are monitored.
- **Retention.** `docs/seosmith.md` states there is no automatic run deletion. Deletion is a separate, owner-facing decision. If it is ever introduced, it must not remove receiver support that retained v2 rows still need.
- **Monitoring metrics (names to be set in H01):** rows and bytes per website; rejected deliveries by reason; duplicate and conflict counts; finalization latency; summary-recompute count and latency; database growth. Alert thresholds are set by the operator. This ADR does not set them.

## Rollout and rollback (receiver first)

Order, following S01 with the corrections noted below:

1. Land shared fixtures in both repositories and the HTP v2 validator (H01, HTP #6). The producer gate stays off.
2. Apply the additive migration: summary and validator accept schema 2, and the summary cache exists.
3. Deploy the API and frontend together, as in `docs/seosmith.md`.
4. Confirm the installed receiver's capabilities advertise v2. **No mechanism for this exists in HTP today.** H01 must choose one (for example, an accepted-versions field in a read endpoint) before the producer gate is enabled.
5. Enable the producer gate in the pilot environment only. Monitor rejections, duplicates, and conflicts.

Rollback:

- **Producer.** Disable the gate. Newly finalized reports are v1 again. Existing delivery payloads are never rewritten, rehashed, or downgraded.
- **Receiver.** **Correction to S01:** S01 says to keep v2 receiver support "until retained reports and retries have drained." HTP does not delete audit rows, so v2 rows become permanent. Receiver support for v2 must be kept for as long as any v2 row exists. Downgrading the receiver below v2 while v2 rows exist breaks reads and summaries.
- **Queued v2 deliveries.** If the receiver is rolled back first, queued v2 payloads are rejected. Retain them for retry; never rehash or downgrade them.

## Tests and pilot exit criteria

### Required tests (both repositories where noted)

Positive fixtures:

- Legacy v1 report, unchanged bytes and receipt.
- v2 complete, v2 partial, and v2 with extraction truncation.
- Exact-byte retry returns the same receipt.

Negative fixtures:

- Byte cap: 16,777,216 octets accepted; 16,777,217 rejected.
- Record boundaries: 20,000 vs 20,001 pages; 40,000 vs 40,001 combined; 400,000 vs 400,001 findings.
- Extension: 128 vs 129 observations; 512 vs 513 evaluations; 1,048,576 vs 1,048,577 bytes; base plus extension exceeding 16 MiB.
- Dangling `/pages/N` pointer; duplicate entity identities; duplicate evaluations.
- Invalid outcome tuples; coverage sums not matching `entities`; a manifest rule missing from coverage.
- Schema 2 without `evidence_contract`; `evidence_contract` under schema 1.
- Duplicate JSON keys; deep nesting.
- Conflicting bytes for the same delivery ID (expect `delivery_conflict`).
- Wrong binding generation, wrong FQDN, disabled binding, invalid token.

Existing PGlite coverage that these extend: `supabase/tests/seosmith-expanded.test.mjs` (independent 20k budgets at line 91-95, 400,000 vs 400,001 findings at lines 114-115, the 16 MiB ceiling comment at line 116, and rejected over-budget pushes at lines 99 and 108).

### Pilot exit criteria

The pilot passes only when all of these are true. No numeric threshold is set here. Each is set by the pilot owner before measurement and recorded in the pilot report.

1. All required tests pass in both repositories, using the same fixtures.
2. Ingest, import, history, and detail latency and database resource use are measured for maximum-size reports, against thresholds set before the run.
3. The fraction of planned crawl inventories that exceed the byte or record budget is measured. This decides whether a chunk protocol is needed in Wave 2.
4. A rollback drill in the pilot environment: disable the producer gate, confirm v2 retries still succeed byte-identically, and confirm receiver v2 support remains.
5. Database growth per website is measured and reported to the operator.
6. Fixture results are not production evidence. Production readiness is claimed only from a separate production rollout record.

## Open decisions (H01 and Wave 2)

1. Add a `duplicate` boolean to receipts? (Additive; needs a versioning decision.)
2. Capability-advertisement mechanism for v2 receivers.
3. Whether detail returns the parsed `report` by default.
4. Shape of the derived summary cache table.
5. Thresholds that would trigger a chunk or object protocol, taken from pilot measurements.
6. Whether v1 duplicate-key handling changes. (v1 is not changed by this ADR.)

## Reconciliation with prior review notes

- **Sonnet review, B2 (size budget).** Addressed by the bounds table, the 15,728,640-byte base limit, and receiver-side extension enforcement.
- **Sonnet review, the "16 KiB delivery body limit at `src/api.rs:29`."** This citation does not match the current tree. `apps/api/src/api.rs` does not exist. The current route limit is 32 MiB (`apps/api/src/seosmith.rs:25,33`). This ADR uses the current value.
- **Sonnet review, M3 (naming).** S01 still calls the policy hash a "signature." The Sonnet review asked for `policy_digest`, because a SHA-256 is not authentication. This is a SEOsmith S01 text change (t9). It is not changed in this repository.
- **Sonnet review, M7 (rollback).** Addressed by the receiver-first rollout and the correction above.
- **S01 "keep v2 until drained."** Corrected above: v2 receiver support is permanent once v2 rows exist.
- **S01 summary-version semantics.** A summary-version bump changes which stored summaries are recomputed on read (see "Existing read-path amplification"). The cache is required before v2 rows exist.

## Consequences

- The pilot stays on existing, verified infrastructure: one inline request, one RPC, one immutable row.
- The byte and record caps are not raised. v2 evidence must fit the existing budget, so some large crawls will be rejected or must use smaller limits. That is the intended fail-closed behavior.
- Read amplification on legacy rows is a known cost until a summary cache exists. The pilot cannot claim bounded history latency before that cache is measured.
- Future chunk or artifact protocols have explicit requirements, so they can be designed later without weakening the current guarantees.
