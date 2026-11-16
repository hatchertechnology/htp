# ADR 0001: Bounded inline evidence transport for the Seosmith pilot

- **Status:** Proposed (Wave 0 design gate). Design only: no code, schema, or deployment change.
- **Tracking:** HTP #19 (H14, "Design bounded artifact storage and atomic report delivery"). #19 stays open until the Wave 2 selected-transport and pilot checks pass.
- **Related:** SEOsmith #1 (S01 observation/evaluation contract v2); HTP #6 and PR #37 (H01 versioned receiver, not merged); HTP #5 (full research and sources); HTP #26 (primary bundle).
- **Date:** 2026-11-16
- **Sources of truth (as cited below):**
  - HTP `origin/main` at `0f704cf` (v1 pipeline).
  - SEOsmith S01 at `1070262` (`docs/contracts/s01-v2.md`). The H01 copy at `4ca092a` is byte-identical.
  - HTP H01 (PR #37) at `4ca092a`. Earlier review snapshot: `4d63d3a`, an ancestor of `4ca092a`.

## Context

Seosmith (the crawler) delivers one JSON report per run to HTP. HTP stores it as an immutable audit row. The v1 pipeline on `main` (`0f704cf`):

- **Exact-byte cap.** The ingest RPC rejects `octet_length(report_json) > 16777216` (`supabase/migrations/20261101054016_seosmith_expanded_evidence.sql`, ingest function, line 84). The import RPC does the same (`supabase/migrations/20261031053413_seosmith_history.sql`, line 51). The API repeats the check before the RPC (`apps/api/src/seosmith.rs:51` for worker ingest, `:98` for import).
- **Record budgets.** `seosmith_summary` rejects more than 40,000 pages, more than 400,000 findings, or more than 20,000 pages with `is_resource` set or unset (`supabase/migrations/20261101060006_seosmith_policy_exclusions.sql`, lines 28-48). Explicit request budgets must be 1-20,000 pages and 0-20,000 resources (same file, lines 51-56).
- **Request body.** The HTP Seosmith routes use `DefaultBodyLimit::max(32 MiB)` (`apps/api/src/seosmith.rs:25,33`). This is an allowance for the JSON envelope, not a larger report allowance (see "Envelope expansion" below).
- **Schema gate.** The ingest RPC checks `schema_version` directly (`20261101054016`, line 92). `seosmith_summary` checks it too (`20261101060006`, line 28). Both paths reject v2 on `main`. This is the intended receiver-first gate.
- **Immutability.** Insert computes the summary through the `seosmith_prepare_audit` trigger. Update is rejected (`20261031053413`, lines 35-43).

S01 v2 (`docs/contracts/s01-v2.md`, identical at `1070262` and `4ca092a`) adds `evidence_contract` inside a report whose original bytes are retained. Its bounds are 128 observations, 512 evaluations, and a compact extension of at most 1,048,576 bytes, all inside the 16,777,216-byte report cap.

The Wave 0 question is whether the pilot can carry v2 evidence inline, or whether a chunk or object protocol is needed first. This ADR answers that for the pilot and records the requirements for a later protocol.

## Decision

1. **Pilot transport is bounded inline.** A report is one JSON envelope with a `report_json` string (`delivery_id`, `sha256`, `report_json`), sent in a single HTTP request. There is no chunk, object, or artifact upload in the pilot.
2. **The 16 MiB exact-report byte cap is retained.** The limit is `octet_length(report_json) <= 16,777,216` in UTF-8, checked at the API and in the database. No body-limit increase is part of this decision.
3. **The record budgets are retained:** 20,000 pages, 20,000 resources, 40,000 combined page and resource records, and 400,000 findings. Each is checked in SQL.
4. **The v2 extension must fit inside the 16 MiB cap after framing.** The binding rule is that the final serialized report, measured by a counting serializer, is at most 16,777,216 bytes. S01 states the legacy base must fit within 15,728,640 bytes at maximum extension "before accounting for the additional report field framing". That figure is the base-only budget. The framing for `,"evidence_contract":` is 21 bytes, so with the literal framing the base must be at most **15,728,619 bytes** at maximum extension. Producers measure the full serialized bytes; they do not add two separately measured pieces. If the total does not fit, finalization fails. It must never emit a silently partial or legacy result. The operator reduces crawl limits and resubmits under a new request ID.
5. **Receiver-side enforcement mirrors the producer.** H01 (PR #37) enforces the extension limits in SQL (`seosmith_validate_evidence`, `20261116210550`, line 125 at `4ca092a`). It does not trust producer counts.
6. **No screenshot, object, chunk, or artifact capability is advertised** until a later protocol ships and is verified. The H01 capability declaration must not list one.
7. **Object or chunk storage is deferred, not rejected.** The "Future protocol requirements" section lists what a later protocol must satisfy. Whether Wave 2 needs it is decided from pilot measurements (see "Pilot exit criteria"), not assumed here.

## Bounds

| Limit | Value | Where enforced | Status |
|---|---|---|---|
| Exact report bytes (UTF-8 octets of `report_json`) | 16,777,216 | API (`seosmith.rs:51`, `:98`); ingest and import RPCs | Enforced on `main` |
| Pages, including resources | 40,000 combined | `seosmith_summary` (`20261101060006` line 33) | Enforced on `main` |
| Pages (non-resource) | 20,000 | `20261101060006` lines 47-48 | Enforced on `main` |
| Resources | 20,000 | `20261101060006` lines 47-48 | Enforced on `main` |
| Findings | 400,000 | `20261101060006` line 33 | Enforced on `main` |
| Explicit `max_pages` / `max_resources` | 1-20,000 / 0-20,000 | `20261101060006` lines 51-56 | Enforced on `main` |
| Extension: observations / evaluations / compact bytes | 128 / 512 / 1,048,576 | `seosmith_validate_evidence` (H01 PR #37 at `4ca092a`) | Implemented in PR #37, not merged |
| Schema 2 nesting depth | 64 containers, root = depth 1 | `seosmith_check_raw_report` (H01 at `4ca092a`, line 349 onward; `max_depth>64` at line 383) | Implemented in PR #37, not merged |
| Duplicate JSON object keys | rejected before parse | `invalid_or_duplicate_json_keys` (H01 at `4ca092a`, line 385) | Implemented in PR #37, not merged |
| Engine/ruleset ≤128 bytes, timestamps ≤64, seed ≤16,384, finding keys 64 lowercase hex | per S01 | H01 validators | Implemented in PR #37, not merged |
| SEOsmith `/v1/runs` submit body | 16 KiB (`DefaultBodyLimit::max(16 * 1024)`, SEOsmith `src/api.rs:29` at `1070262`) | SEOsmith run-control API | Real, but it limits run submission only. It does not apply to report delivery. |
| HTP Seosmith route body | 32 MiB | `apps/api/src/seosmith.rs:25,33` | Enforced on `main`; envelope allowance only |

## Serialization and amplification bounds for v2

- **Bounded before serialization.** S01 builds metadata from source JSON pointers and bounded scalar strings, with per-rule aggregates. It does not build a page-by-rule vector. Coverage counts all observed entities, even when their metadata is omitted, and records the omission as `contract_limit`.
- **Nesting depth: 64, root counts as depth 1.** S01 (`1070262`, lines 113-116): "at most 64 nested JSON object/array containers, counting the root as depth 1". The producer checks depth while serializing; over-depth reports fail finalization. Receivers reject over-depth input before parsing. H01 implements this as a raw token scan (`seosmith_check_raw_report`, `max_depth>64`). Required fixtures: depth 64 accepted, depth 65 rejected.
- **Duplicate keys rejected before parse.** S01 requires "no duplicate object keys". H01 rejects them in the raw scan. Reason: PostgreSQL `jsonb` keeps only the last value of a duplicated key (PostgreSQL's JSON-type documentation; not reproduced in this session), so parsed evidence could otherwise differ from the exact bytes.
- **Validation order (receiver).** Check the exact-byte cap first. Run the raw depth and duplicate-key scan. Parse once. Check schema fields, record counts, extension size, and per-field bounds. Compute the summary last. Reject before any insert.
- **Summary must accept schema 2 before any v2 insert.** The insert trigger calls `seosmith_summary`, which rejects any `schema_version` other than 1 on `main`. Enabling v2 without updating the summary function fails every v2 insert. PR #37 adds the v2-compatible summary. This ordering is part of rollout.

### Envelope expansion

The 32 MiB route body limit does not guarantee that a worst-case 16 MiB report fits. `report_json` is a JSON string inside the envelope, so quotes and backslashes are escaped a second time. A report dominated by such bytes can expand to about 2× its size. Its envelope can then exceed 32 MiB and be rejected at the route before the exact-byte check (expected 413; the fixture must confirm this). This is fail-closed. The pilot gate therefore needs a near-cap, escape-heavy fixture that shows the rejection, not only a low-escape fixture that shows acceptance.

### Read-path amplification

**On `main` (verified in migrations):**

- Summaries are not cached for legacy rows. History and detail reuse the stored summary only when `summary_version` matches the current version (`'3'` in `20261101060006`, lines 96 and 111). Otherwise they call `seosmith_summary(report)`. The immutability trigger forbids updates, so older rows are recomputed on every read. A history page fetches `p_limit + 1` rows (up to 101) before trimming, and each recomputation makes several full passes over the stored report.
- Detail returns both the parsed `report` (jsonb) and `raw_report_json` (text). For a near-cap report, one detail response carries roughly two copies of the document.

**In PR #37 (H01 at `4ca092a`):**

- A derived cache table `seosmith_summary_cache` keyed by `(delivery_id, summary_version)`, with `on delete cascade` from `seosmith_audits` (`20261116210550`, line 393 onward). New rows are written as version 4. History and detail join the cache for non-v4 rows.
- The migration backfills the cache for every existing non-v4 row. That backfill recomputes every legacy summary once, so its duration on production-sized tables must be measured before the migration is applied. A derivation that fails during backfill is stored as `evidence_state: legacy_unknown` with `summary_derivation_failed: true` (`seosmith_cached_legacy_summary`). Those rows must never count as complete coverage. `supabase/tests/seosmith-versioned.test.mjs` covers this fallback.

Still required before the pilot:

- Measure the backfill duration and history and detail latency at the largest pilot report.
- History returns compact summary fields only. The full extension stays out of list responses.
- Decide whether `report` remains in the default detail response, based on that measurement.

## Exact-byte digest, ownership, binding generation, and idempotent receipt

These properties already hold for worker ingest on `main` (`20261101054016`, ingest function). They are retained unchanged:

1. **Exact bytes.** `p_sha256` must equal the SHA-256 of `convert_to(p_report_json, 'UTF8')`. The raw text is stored in `raw_report_json`, and the digest is the receipt.
2. **Ownership.** The bearer token's SHA-256 selects an enabled `seosmith_bindings` row. The website row is locked `FOR SHARE`. The FQDN must match the report's request URL.
3. **Binding generation.** `request.binding_generation` must equal the binding's `generation`. `request.website_id` must match the binding. `request.request_id` must equal `delivery_id`.
4. **Idempotency.** A transaction-scoped advisory lock keyed on `delivery_id` serializes concurrent deliveries. A duplicate with the same digest and website returns the same receipt. A different digest or website raises `delivery_conflict` (SQLSTATE 23505).
5. **Atomic receipt.** The row insert and the returned receipt come from one RPC call. A receipt is returned only after commit.

Gaps to resolve in H01 (none block the pilot):

- The duplicate response is identical to a first acceptance (`accepted: true`). Receipts are still only `{delivery_id, sha256, accepted}` in PR #37. An additive `duplicate` boolean would let operators distinguish them. This changes the wire envelope, so it needs a deliberate decision.
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
- **Retention.** Seosmith run records are not expired automatically. Audit rows are not deleted per run. They are removed when their website is deleted: `seosmith_audits.website_id` references `websites(id) on delete cascade` (`20261031053344`, line 10), and the H01 cache cascades from the audit row. Website deletion follows HTP's existing cascade policy (`docs/seosmith.md`). Any other deletion path is a separate, owner-facing decision.
- **Monitoring metrics (names to be set in H01):** rows and bytes per website; rejected deliveries by reason; duplicate and conflict counts; finalization latency; summary-recompute count and latency; cache backfill duration; database growth. Alert thresholds are set by the operator. This ADR does not set them.

## Rollout and rollback (receiver first)

Order, following the rollout section of S01 at `1070262`:

1. Land the shared fixtures in both repositories and the HTP v2 validator (H01, PR #37). The producer gate stays off.
2. Apply H01's additive migration: v2-compatible summary, raw depth and duplicate-key scan, extension validator, capability declaration, and summary cache with backfill. Measure the backfill first on production-sized data.
3. Deploy the API and frontend together, as in `docs/seosmith.md`.
4. Confirm the installed receiver's capabilities advertise v2. H01 implements this as `seosmith_receiver_capabilities()` (granted to `anon` and `authenticated`), exposed by `GET /integrations/seosmith/capabilities`. It is implemented in PR #37 and not merged. Its declaration lists schema versions, the extension limits, depth 64, unique keys, and the 16 MiB cap.
5. Enable the producer gate in the pilot environment only. Monitor rejections, duplicates, and conflicts.

Rollback (S01 `1070262`, lines 27-29 and 138-139):

- **Producer.** Disable the gate. Newly finalized reports are v1 again. Existing delivery payloads are never rewritten, rehashed, or downgraded.
- **Receiver.** Keep v2 receiver support for as long as any v2 audit row is retained. S01 states: "keep v2 receiver support permanently while any v2 audit row is retained", and "v2 support is permanent once a v2 row exists unless those rows are explicitly migrated or removed." Downgrading the receiver below v2 while v2 rows exist breaks reads and summaries.
- **Queued v2 deliveries.** If the receiver is rolled back first, queued v2 payloads are rejected. Retain them for retry; never rehash or downgrade them.

## Tests and pilot exit criteria

### Required tests (both repositories where noted)

Positive fixtures:

- Legacy v1 report, unchanged bytes and receipt.
- v2 complete, v2 partial, and v2 with extraction truncation.
- Exact-byte retry returns the same receipt.

Negative fixtures:

- Byte cap: a final report of 16,777,216 octets is accepted; 16,777,217 is rejected.
- Framing boundary: base + extension + `,"evidence_contract":` framing = 16,777,216 accepted; +1 byte rejected.
- Envelope expansion: a near-cap, escape-heavy report is rejected at the route (expected 413) with no receipt. The fixture confirms the actual status code.
- Depth: 64 containers accepted; 65 rejected before parse.
- Duplicate JSON keys rejected before parse.
- Record boundaries: 20,000 vs 20,001 pages; 40,000 vs 40,001 combined; 400,000 vs 400,001 findings.
- Extension: 128 vs 129 observations; 512 vs 513 evaluations; 1,048,576 vs 1,048,577 bytes.
- Dangling `/pages/N` pointer; duplicate entity identities; duplicate evaluations.
- Invalid outcome tuples; coverage sums not matching `entities`; a manifest rule missing from coverage.
- Schema 2 without `evidence_contract`; `evidence_contract` under schema 1.
- Cache backfill failure yields `legacy_unknown` and never complete coverage.
- Conflicting bytes for the same delivery ID (expect `delivery_conflict`).
- Wrong binding generation, wrong FQDN, disabled binding, invalid token.

Existing PGlite coverage these extend (`supabase/tests/seosmith-expanded.test.mjs`): the accepted worker push at line 99; the rejected import at line 104 (`invalid_seosmith_findings|report_limit`); the rejected worker push at line 108; independent 20k budgets at lines 91-95; 400,000 vs 400,001 findings at lines 114-115; the 16 MiB ceiling comment at line 116.

### Pilot exit criteria

The pilot passes only when all of these are true. No numeric threshold is set here. Each is set by the pilot owner before measurement and recorded in the pilot report.

1. All required tests pass in both repositories, using the same fixtures. The S01 copies are byte-identical at `1070262` and `4ca092a`. A DeepSeek review checked the shared fixtures as byte-identical at H01 `4d63d3a`; recheck at the final head.
2. Ingest, import, history, detail, and the cache backfill are measured for maximum-size reports, against thresholds set before the run.
3. The fraction of planned crawl inventories that exceed the byte or record budget is measured. This decides whether a chunk protocol is needed in Wave 2.
4. A rollback drill in the pilot environment: disable the producer gate, confirm v2 retries still succeed byte-identically, and confirm receiver v2 support remains.
5. Database growth per website is measured and reported to the operator.
6. Fixture results are not production evidence. Production readiness is claimed only from a separate production rollout record.

## Open decisions (H01 and Wave 2)

1. Add a `duplicate` boolean to receipts? (Additive; needs a versioning decision. Still open in PR #37.)
2. Capability advertisement: decided in H01 as `seosmith_receiver_capabilities()` and `GET /integrations/seosmith/capabilities` (PR #37, not merged). Confirm in review.
3. Whether detail returns the parsed `report` by default.
4. Derived summary cache: implemented in H01 as `seosmith_summary_cache` (PR #37, not merged). Confirm the backfill strategy after measuring it.
5. Thresholds that would trigger a chunk or object protocol, taken from pilot measurements.
6. Whether v1 duplicate-key handling changes. This ADR does not change v1.

## Reconciliation with prior review notes

- **Sonnet review, B2 (size budget).** Addressed by the bounds table, the framing-aware base budget (15,728,619 bytes with the 21-byte framing), and receiver-side extension enforcement in H01.
- **The 16 KiB limit (`src/api.rs:29`).** This limit is real. It is `DefaultBodyLimit::max(16 * 1024)` on SEOsmith's `/v1/runs` run-control router at `1070262`. It limits run submission, not report delivery. An earlier revision of this ADR wrongly called the citation stale, because it looked in HTP's tree (`apps/api/src/api.rs`, which does not exist). HTP's delivery limits are the 32 MiB route body and the 16 MiB exact-byte cap.
- **Sonnet review, M3 (naming).** S01 `1070262` line 105 keeps the wire name `signature` for H01 compatibility, and says it "denotes a digest only", not authentication. The M3 concern is addressed by that text. A rename would be a separate wire change.
- **Sonnet review, M7 (rollback).** Addressed by the receiver-first rollout and the rollback rules above.
- **S01 "keep v2 until drained."** Superseded. The producer S01 (`1070262`) says v2 support is permanent while any v2 audit row is retained. The H01 copy at `4ca092a` is byte-identical. The earlier "correction" in this ADR is withdrawn because it quoted an outdated S01 text.
- **S01 summary-version semantics.** A summary-version bump changes which stored summaries are recomputed on read. The cache in PR #37 addresses this, but its backfill must be measured first.

## Consequences

- The pilot stays on existing, verified infrastructure: one inline request, one RPC, one immutable row.
- The byte and record caps are not raised. v2 evidence must fit the existing budget, including framing, so some large crawls will be rejected or must use smaller limits. That is the intended fail-closed behavior.
- Read amplification on legacy rows is a known cost on `main`. PR #37 adds a cache, but the pilot cannot claim bounded history latency until the backfill and cache are measured.
- Future chunk or artifact protocols have explicit requirements, so they can be designed later without weakening the current guarantees.
