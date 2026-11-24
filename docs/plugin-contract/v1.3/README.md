# Audit read profile 1.3.0 — definition, producer gated

This additive profile closes the shared-inventory/conformance gap for two new
owner-scoped stored reads, `website_audit_events` and
`website_operational_episodes`. It extends the accepted 1.0.0 baseline and the
provider-request 1.1.0 and audit-export 1.2.0 profiles. `audit-reads.json`
records the operation identity, inputs, result shape, availability semantics,
limits and held gates; `conformance.json` holds the synthetic scenarios.

The reads are additive operations, so the shared policy requires a new minor
profile rather than editing the frozen 1.0.0 inventory. Historical v1, accepted
1.1 and accepted 1.2 contract bytes and pins remain byte-for-byte unchanged.
`historical-v1.2-source/` archives exactly the four accepted1.2 skill files so
the immutable 1.2 source lock stays verifiable. Current source uses the new1.3
lock. The shared `website-management` skill gained the read paragraph in this
profile; changing source does not silently promote any host pin or deployed
backend.

The H15 producer/processor gates are disabled. These reads are defined now;
the backend implementation, deployment/endpoint acceptance and all three
current-source readiness companions remain gated. Contract checks prove no
feature availability. Rediscover deployed tools and input schemas before use;
a missing tool is unsupported, never an empty report and never permission to
collect data.

## Wire contract

Both reads require `website_id` (UUID) and accept an optional bounded `limit`
(integer 1–100, default 50) plus the paired persisted cursor `before` (RFC3339
timestamp) and `before_id` (UUID) from the previous page's `next_cursor`.
Supplying only one cursor component is invalid. Every call authenticates a
nonanonymous subject and freshly checks current website ownership/FQDN. The
page never crosses the current FQDN.

| Tool | Success `structuredContent` |
| --- | --- |
| `website_audit_events` | `{semantics_version:1,events:[…],has_more,next_cursor,availability}` |
| `website_operational_episodes` | `{version:1,episodes:[…],has_more,next_cursor,availability}` |

`next_cursor` is `{before,before_id}` when `has_more` is true and `null`
otherwise. Follow it with both values. `has_more` true means another page may
exist; it never means the history is complete, and a successful page is never a
fresh-collection promise. Both reads create zero provider collection jobs and
zero crawl runs, and never start collection, claim, processing or delivery.

## Producer availability and discovery

`availability` is explicit. While the H15 producer gates are disabled the value
is `producer_unavailable`; other values are not defined by this profile.
`producer_unavailable` is **not** an empty history, **not** a zero count and
**not** proof that no events or episodes exist. It must not be presented to a
user as a clean or passing result, and it must not be synthesized into an empty
success when the tool is missing. Discover at connection time; absence from
`tools/list` is `unsupported`, never a substituted operation or a zero count.
Preserve sanitized auth/error information and fail closed.

| Code | Meaning / client action |
| --- | --- |
| auth_required | Missing, invalid, expired or anonymous authentication; sign in again. |
| forbidden | Authenticated but not the current website owner/FQDN; do not infer absence. |
| invalid_cursor_or_limit | Limit outside 1–100 or an unpaired cursor; correct the inputs. |
| unavailable | Upstream/IO failure; preserve failure, never an empty page. |
| unsupported | Tool/support absent; never substitute another operation. |

## Offline semantic conformance and evidence limits

Run from the canonical tree with Node 22+:

```sh
node scripts/check-plugin-contract.mjs
node scripts/check-audit-read-contract.mjs
node --test scripts/plugin-contract.test.mjs scripts/provider-request-contract.test.mjs scripts/audit-export-contract.test.mjs scripts/audit-read-contract.test.mjs
```

The default generates synthetic observations and validates them semantically.
It executes no backend or host. Tests mutate transcripts to prove rejection of
missing capability, unpaired cursors, out-of-range limits, authorization and
owner denial, collection scheduling, non-`producer_unavailable` success and
empty pages that erase explicit producer availability. External input is
exactly `{contractVersion:"1.3.0",host,observations}` for host one of
backend/claude/codex/pi; each observation is `{id,result,effects}` keyed by a
canonical scenario id. Fixtures are offline specification evidence only; they
cannot prove provenance, side effects, live auth or producer support.

## Migration, source pins and readiness

Historical v1, accepted1.1 and accepted1.2 artifacts, locks and host pins remain
byte-for-byte unchanged. `historical-v1.2-source/` archives exactly the four
accepted1.2 skill files, checked against the immutable old lock. Current source
uses the new1.3 lock; the old v1.2 lock is retained as accepted history and is
no longer the current-source pin. The old profiles continue to describe their
accepted revisions.

After reviewed canonical merge, three coordinator-owned companion readiness
changes must preserve each old pin and add a separate1.3 lock/vendor tree.
Required canonical paths: this profile README/JSON/conformance/source-lock, the
`scripts/audit-read-contract.mjs` validator, the standalone checker, and all
four skills/reference files in the new lock. Claude must also update the actual
shipped shared skills and verify them against the1.3 lock. Codex/Pi remain
vendored-source readiness only until installable runtime work separately ships.
No host edits belong to this canonical PR. Host installation/OAuth/runtime,
producer activation, deployment and rollback gates remain separate; roll back
to a verified pin while preserving stored events, episodes and reports.
