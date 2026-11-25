# Forms owner MCP parity

Implemented locally on exact base `5c24a25c80b20710c1c163b2ca165e1c330c5bd7`.
Worktree: `/mnt/storage/worktrees/w1-forms-owner-mcp`.
No push, deployment, hosted access, external messages, or agents were used.

Read `/mnt/storage/projects/hatchtechplatform/AGENTS.md` (the umbrella
coordination rules; no separate coordination/AGENTS.md exists), and the Rust
router, domain-web, async/concurrency and Supabase skills. The user instruction
limits this task to synthetic tests: no hosted Supabase checks, JWT construction,
credential extraction, or new Supabase APIs/schema changes were needed.

## Implementation

- Added `list_form_hosts`, `list_website_forms`, `list_form_responses`,
  `save_website_form`, and `delete_form_response` to authenticated API MCP.
- Fixed, typed adapters invoke the existing REST handlers directly, reusing
  owner/pilot checks, validation, typed Rust clients, allowlisted host metadata,
  response projections, RPC success checks, and sanitized/uncertain errors.
  No generic router/HTTP forwarding or caller-selected RPC/path is exposed.
- All handlers require the trusted `AuthenticatedUser` extension plus the
  caller's existing bearer. Tests inject the trusted identity synthetically;
  they never simulate an owner JWT or call an auth system.
- Discovery independently gates reads, saves and response deletion using the
  existing default-off inbox/save/response flags and a valid pilot pair.
  Execution repeats the gate and exact owner/site checks. Existing DNS
  verification has its own unchanged gate. The demo inventory uses the same
  owner-group gates and executes no owner operation.
- Host metadata returns `verified_at`; null is explicitly unverified. No DNS
  challenge hash/value is returned. Lists use REST's existing 1–100 limit,
  default 50, offset and has_more semantics (no invented next_offset).
- Save supports inactive creates and active updates, bounded fields/host IDs,
  existing database authority, and conservative unknown outcomes.
- Delete requires exact website/form/response UUIDs and confirm_delete=true.
  It is destructive, non-idempotent, single-response only, and requires explicit
  user intent. Sending-lock and unknown outcomes remain errors with no adapter
  retry. Bulk/wildcard/arbitrary arguments are rejected.
- Added `docs/forms/owner-mcp.md`; frozen contracts, archived skill sources,
  pins, current plugin skills, grants, migrations and environment flags remain
  unchanged. Five focused transport tests live in `mcp_forms_tests.rs`.

## Exact final validation

All commands ran from this worktree. Rust fixtures use localhost synthetic
upstreams only; contract checks are offline Node fixtures.

| Command | Result |
| --- | --- |
| `cargo test -p htp-api --lib form --locked` | Exit 0: 84 passed, 0 failed, 3 ignored, 96 filtered out. Includes all five new MCP tests. |
| `cargo test -p htp-api --test mcp --locked` | Exit 0: 7 passed, 0 failed. |
| `cargo fmt --all -- --check` | Exit 0. |
| `git diff --check` | Exit 0. |
| `node scripts/check-plugin-contract.mjs` | Exit 0: baseline 25 operations / 38 scenarios / 3 host profiles; 1.1 provider, 1.2 export, 1.3 read profiles passed. |
| `node scripts/check-audit-export-contract.mjs` | Exit 0: synthetic export semantics passed. |
| `node scripts/check-audit-read-contract.mjs` | Exit 0: synthetic read semantics passed. |
| `node --test scripts/plugin-contract.test.mjs scripts/plugin-contract-versioning.test.mjs scripts/provider-request-contract.test.mjs scripts/audit-export-contract.test.mjs scripts/audit-read-contract.test.mjs` | Exit 0: 186 passed, 0 failed, 0 skipped. |
| `cargo clippy -p htp-api --all-targets --locked -- -D warnings` | Exit 101: 20 findings in unchanged code. No diagnostic in the new adapters/tests. |

The three ignored tests require browser/disposable PostgREST fixtures:
`form_ingress::tests::browser_cors_against_actual_api`,
`form_ingress::tests::disposable_pilot_postgrest_browser_cors`, and
`form_ingress::tests::disposable_postgrest_acceptance_and_retry`. They were not
run or represented as passes.

New MCP transport tests cover all eight flag combinations with/without pilot
scope; discovery annotations/closed schemas; trusted identity and bearer
requirements; wrong owner/site for every operation; runtime disabled defenses;
invalid paging/save/bulk arguments before upstream; host challenge projection;
exact bounded website/form queries; inactive create and active update payloads;
explicit deletion; sending-lock/unknown error envelopes and single attempts.

Strict Clippy's unchanged-code findings are in lib.rs, dashboard_cors.rs,
form_ingress.rs, form_responses.rs's existing write match, form_verification.rs,
mcp.rs's existing ReportToolInput documentation, playground.rs, search.rs and
websites.rs. Findings include existing style/line-count/documentation lints.
They are outside this change and the strict lint check remains failing.

## Contract/release gates

The frozen baseline inventory deliberately remains the default tool set, as
with existing opt-in verification tools. Passing archival checks does not
provide a shared Forms contract. Before shared plugin packages advertise these
operations, agree/review an additive Forms capability profile, input/result and
uncertainty semantics, and synthetic per-host conformance evidence without
rewriting any archived profile or accepted source pins.

Exact-head independent reviews (not performed: user prohibited agents),
coordinator integration, deployment, database grants, exact pilot configuration
and live host acceptance remain separate release gates. No hosted availability,
RLS correctness, Forms activation or production result is claimed here.
