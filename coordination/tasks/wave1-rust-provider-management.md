# Rust provider management — implemented, activation blocked

Date: 2026-11-25
Worktree: `/mnt/storage/worktrees/w1-rust-provider-management`
Authoritative base: `234d9f287a016f3255b54687226cb3e308b74fb6`
PR119 merge reported by coordinator: `1f0cffbb862412f0a272f8002bca31fdbb4a7773` (same source; no rebase performed).

## Implementation

- Native Rust/Fly GET/DELETE Google and Bing connection operations and Google
  owner URL Inspection, selected by the existing exact-true
  `HTP_ROLLOUT_PROVIDER_OAUTH` gate. REST and MCP share the same callers and
  sanitized success/error envelopes. Held rollout retains the existing bridge.
- Verified nonanonymous Supabase identity supplies every grant owner filter and
  tombstone owner. Duplicate/malformed authorization headers use the existing
  bearer validator; JWT/JWKS verification reuses the existing verifier.
- Nitro metadata semantics preserved: configured independently by provider,
  connected includes reauthorization_required, scope flags from stored Google
  scopes, empty/missing rows disconnected. Status never returns encrypted grant,
  generation, tokens, provider bodies or owner identity. REST adds private/no-store.
- Disconnect writes the existing table's empty disconnected tombstone with fresh
  UUID generation and timestamp, clearing Google scopes. Saved evidence remains.
- Google refresh decrypts PR119/Nitro AES-GCM owner-purpose AAD and existing
  `{user,refresh,scopes}` grant format. Search scope required. Access tokens remain
  request-local. Rotated refresh tokens use existing `rotate_google_grant` RPC
  with the generation originally read alongside the grant, preventing overwrite
  of a concurrent reconnect/disconnect. A false CAS leaves the newer row intact;
  like Nitro, the current request can still finish with its issued access token.
- Owner inspection checks website ownership through owner-authenticated RLS,
  validates property/URL boundaries before refresh, then reuses existing Rust
  SearchClient inspection, response checks and save_search_inspection RPC.
  Caller-supplied Google headers are replaced by the server-issued token.
- Native management token/store HTTP disables redirects, uses 15-second deadlines
  and 64 KiB JSON bounds. Existing SearchClient retains its existing timeout and
  quota/error handling. No sensitive logging introduced.
- Only Rust API and API documentation changed, plus this requested report.
  No Cloudflare runtime, Nitro implementation, frontend, schema, Fly config or
  rollout-flag changes.

## Exact missing dependency — NOT activation-ready

PR119 OAuth callbacks still unconditionally upsert connected grants. A consent
callback exchanging a code can finish after disconnect and overwrite its
fresh-generation tombstone. A local mutex, pending-ledger deletion, or refresh
rotation's generation fence does not solve this cross-process database race.

Required contract before activation: shared per-owner/provider consent epoch,
snapshotted when connect is issued; disconnect atomically advances the epoch and
writes the tombstone; callback atomically compares the captured epoch while
writing its grant and rejects stale consent. The contract must handle absent
rows as well as existing connections. This requires a database RPC/schema
contract and integration with both provider callbacks. No claim is made that
this dependency exists or that native activation is safe.

Coordinator follow-up F1/F2: singleton with no auto-stop is still required while
PR119 uses its in-process ticket/state ledger. No config edits were made. Add a
small per-owner pending cap in `apps/api/src/provider_oauth.rs::connect`, under
the existing tickets lock after expired-entry pruning and before insertion.
Current global 1024-entry bound remains. Only seal/unseal visibility changed in
that module; pending-store changes were reserved for the coordinator.

Legacy Google browser cookies cannot be read, migrated, or deleted across hosts
by Fly. Existing Nitro one-time migration remains intact; migrate there before
static cutover or reconnect natively. A tombstone blocks cookie restoration.
Native requests neither import caller cookies nor export grants. The held gate
continues the legacy receiver behavior.

## Synthetic validation

- `cargo test -p htp-api --locked --tests`: 209 passed, 10 existing ignored,
  zero failures (library 169/7 ignored; auth integration 33/3; MCP 7).
  Log: `/tmp/w1-provider-management-tests.log`.
- Six new native tests cover metadata/privacy, fresh-generation tombstones,
  missing identity, wrong-owner/disconnected/missing-scope refusal, compatible
  owner-AAD decryption, escaped refresh form, original-generation RPC and false
  CAS, request-local access tokens, redirect/error/oversize rejection. Fixtures
  use synthetic credentials and loopback servers only.
- Existing suites cover REST bridge envelope/status mapping, MCP routes/tools,
  OAuth crypto/consent, website ownership and Search URL/property boundaries,
  provider quota errors and inspection evidence persistence. This does not claim
  a complete enabled-rollout end-to-end test through real JWT/provider services.
- `cargo clippy -p htp-api --locked --all-targets`: passed, existing repository
  warnings remain; no warning in provider_management.rs.
- `cargo fmt --all -- --check` and `git diff --check`: passed.

No production, live provider/database, credentials inspection, agents, push,
deploy, DNS change, or registration update. Independent reviews and activation
qualification remain coordinator-owned. Local source commit is recorded in git;
central coordination copy records its exact SHA after commit.
