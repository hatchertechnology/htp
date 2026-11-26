# Parity read profile 1.4.0 — definition, held by rollout flags

This additive profile names three owner-scoped stored reads that the REST API
already serves and the MCP did not: `website_audit_lifecycle`,
`website_url_lifecycle` and `website_remediation_list`. It extends the frozen
1.0.0 baseline and the 1.1.0 provider-request, 1.2.0 audit-export and 1.3.0
audit-read profiles; none of those bytes change. `parity-reads.json` records
operation identity, inputs, result shape, limits and gates; `conformance.json`
holds the synthetic scenarios.

The reads are additive operations, so the shared policy requires a new minor
profile rather than editing the frozen 1.0.0 inventory. This profile adds no
skill text: the `plugins/htp/skills` source stays pinned by the 1.3 lock, so
capability-gated skills for 1.4 are a host-package change, not part of this
contract commit. Contract checks prove no feature availability.

## Wire contract

Every call authenticates a nonanonymous subject, freshly checks current website
ownership and FQDN, and forwards the caller's own bearer token to the same
database function as the REST route. No call starts a crawl, provider
collection, event processing or any write.

| Tool | Inputs | Success `structuredContent` |
| --- | --- | --- |
| `website_audit_lifecycle` | `website_id`, `entity_id`, `rule`, optional `limit` 1–100 (default 50), paired `before` + `before_id` | `{version:1,entity_id,rule,items:[…],has_more,next_cursor}` |
| `website_url_lifecycle` | `website_id`, `entity_id`, optional `limit`, paired `before` + `before_id` | `{version:1,entity_id,items:[…],has_more,next_cursor}` |
| `website_remediation_list` | `website_id`, `delivery_id`, `finding_index` ≥ 0, optional paired `before` + `before_id` | `{version:1,delivery_id,finding_index,items:[…],has_more,next_cursor}` |

`next_cursor` is `{before,before_id}` when `has_more` is true and `null`
otherwise; follow it with both values. Supplying only one cursor component is
invalid. Lifecycle items omit evidence values (`evidence_values_omitted`).

`website_remediation_list` is the web dashboard's remediation work queue entry
for one finding. The database returns one work item per (audit, finding) with
its newest 50 verification attempts; `next_cursor` pages the attempts. An
unsaved finding yields `items: []`, which means no work has been saved for it
and says nothing about the finding itself. Saving work and recording attempts
stay web-only.

## Rollout holds and discovery

Each operation names its rollout flag (`rolloutFlag`). While the flag is off in
the deployed API the tool is still listed and answers an error result with
`code: "unavailable"` and `status: 503`. That is **not** an empty history, **not**
an empty work queue and **not** proof that nothing exists; it must not be shown
as a clean result. The same code covers an unreachable store. A tool missing
from `tools/list` is `unsupported`, never a substituted operation or zero count.

| Code | Meaning / client action |
| --- | --- |
| auth_required | Missing, invalid, expired or anonymous authentication; sign in again. |
| forbidden | Authenticated but not the current website owner/FQDN (MCP surfaces REST 403/404); do not infer absence. |
| invalid_cursor_or_limit | Limit outside 1–100 or an unpaired cursor; correct the inputs. |
| unavailable | Rollout held or upstream failure (`status` 503); preserve it, never an empty page. |
| unsupported | Tool/support absent; never substitute another operation. |

The three 1.4 tools emit exactly these values in `code`, with the REST HTTP
`status` and a sanitized `error` message: no or invalid token → `auth_required`
(401); not the owner → `forbidden` (403); a limit or cursor the database rejects →
`invalid_cursor_or_limit` (400); rollout held or any upstream failure →
`unavailable` (503). `unsupported` is a host-side result for a tool the server
does not list; the server never emits it.

## Offline semantic conformance and evidence limits

Run from the canonical tree with Node 22+:

```sh
node scripts/check-plugin-contract.mjs
node scripts/check-parity-read-contract.mjs
node --test scripts/parity-read-contract.test.mjs
```

The default generates synthetic observations and validates them semantically.
It executes no backend or host. Tests mutate transcripts to prove rejection of
held reads erased into empty pages, missing capability, unpaired cursors,
out-of-range limits, authorization and owner denial, writes, collection
scheduling and surplus fields. The Rust tests in `apps/api/src/mcp_parity_tests.rs`
cover flag-off holds, owner forwarding, nonowner denial and cursors against a
mock database. These are fixture consistency, not deployment or host evidence.
