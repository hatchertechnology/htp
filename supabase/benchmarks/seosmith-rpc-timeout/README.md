# Local PostgREST timeout investigation

This is a reviewable candidate, not production rollout authorization. The original migration (`20261116233148`) set only the two RPC functions' `statement_timeout` to 8s; it does not alter role or global settings, validation, trigger, bytes, caps, or authorization. **The current ingest budget is 20s** (migration `20261117120000`, see the correction section below); the 8s figure describes that original candidate. Supabase documents function-level REST timeouts, and PostgREST documents that `statement_timeout` must be included in `db-hoisted-tx-settings` for the setting to apply before the main query. A function setting alone does not extend an already-running direct SQL statement.

Run `TMPDIR=/path/on/storage PGPORT=55444 RESTPORT=55445 supabase/benchmarks/seosmith-rpc-timeout/run.sh` from this checkout. It starts disposable local containers and never contacts a hosted database. Requirements: Podman, Node, curl and PostgreSQL/Supabase test images. Generator SHA-256 `464c3476825d127772732642dfaec729e936460cdaf7cb955ef0f007de885ed1`. Local image digests: PostgREST 14.18 `sha256:c847127074bd26e1b8d3f7c0e6e01e5346f4b85dd34f5d699fd230af960827c0`; Supabase PostgreSQL 17.11.0.004 `sha256:e85bc10ac5b141223b289e1e8dc8d448cf3df92501917149db0366b9c5aaf053`. Local PostgREST dump-config included `statement_timeout` in hoisted settings. The `auth.jwt()` and `auth.uid()` shims reproduce the deployed SQL definitions provided by read-only integration inspection. Local JWT/password are test-only.

The matrix exercises unrelated anon 3s and authenticated 8s endpoints, a 5s hoisted probe, timeout rollback, direct SQL under 3s, three fresh token-heavy and three string-heavy deliveries on each path, receipt/raw/JSON/hash checks, retry, valid conflict, invalid token, duplicate key, and 16 MiB exact/+1 boundary. The hosted backend was observed reporting PostgREST 14.18, but its effective `db-hoisted-tx-settings` has not been verified; a deployment-specific HTTP check is required. Preserved prior actual 3s timeout: coordination `integration/terra-native-rehearsal/result-1bd8bef-extended3.txt`, 3.207s. Local timings do not prove full-budget production acceptance.

Security and deadline review: worker token validity is checked before raw structural scanning and JSONB validation, but the RPC checks size and hashes raw bytes first, and PostgREST/API must receive and parse the envelope before the database can authenticate the embedded token. The Axum handler extracts the JSON body before checking the bearer header; its body cap is 32 MiB and raw report cap is 16 MiB. No ingress rate or concurrency limit was identified in these source paths; external infrastructure may have controls and must be verified before enabling a longer worker budget. Under the current 20s ingest budget, a valid-token or authenticated ingest call may occupy a DB connection for up to 20s (2.5x the previous 8s). Invalid-token or wrong-sha requests are rejected in under ~0.6s at 0.2 CPU before the expensive raw scan/parse, so failed pre-auth calls do not occupy the full budget. Import authenticates and checks ownership before raw validation. Deadline chain after the correction (30 > 25 > 20): worker delivery client 30s -> HTP API `ingest_seosmith` 25s -> PostgREST -> DB 20s; owner browser `$fetch` (no explicit timeout) -> Nuxt server proxy 30s -> HTP API `import_seosmith_audit` 25s -> DB 20s; every other `rpc()`/`request()` path keeps 10s. End-to-end client-disconnect/retry behavior remains a rollout gate. A database timeout aborts and rolls back its transaction; an HTTP client timeout alone is not proof of rollback. No global/role timeout change is proposed.

Owner-denial matrix uses large near-limit malformed reports with distinct request IDs: anonymous caller must be denied access to the import RPC and a different authenticated owner must receive `forbidden`, with no accepted receipt or audit row. The cross-owner duplicate-key payload checks that database ownership rejection precedes the raw scanner and JSONB validation; it does not show that the HTTP server avoided receiving or parsing the JSON envelope. The API and PostgREST still accept and parse the envelope before the database ownership check. Separate unique IDs for invalid token and oversize worker/import requests allow explicit no-row assertions.

## Bounded ingest budget correction (20s)

Migration `20261117120000_seosmith_ingest_budget.sql` raises `statement_timeout` to 20s on only `ingest_seosmith_audit` and `import_seosmith_audit`. The earlier 8s bound was measured against warm unconstrained local CPU and is insufficient for a valid near-limit token-heavy schema-2 report (15,236,654 raw bytes, ~7.6M-element unrelated root array): hosted ingest was cancelled with SQLSTATE 57014 at ~9.5s, and locally the same report needs ~13.6-13.8s at 0.2 CPU. `apps/api/src/websites.rs` keeps its client deadline above the database budget (25s for the two ingest RPCs; other RPCs keep 10s). Validation, caps, the immutable-audit trigger, authorization, role defaults and stored bytes are unchanged. Evidence: `ingest-budget-result.txt`; reproduce with `PG_CPUS=0.2 TMPDIR=/path/on/storage first-insert.sh` (worker) or the full `run.sh`/`matrix.sh`. Hosted effective hoisting, pooler limits and production CPU remain integration gates.

### Timing limits and margin

At 0.2 CPU the token-heavy first insert completed in 15.58s (worker) / 16.24s
(import) under the 20s budget; the independent t3n review reproduced 13.98s /
13.93s. The worst observed completion therefore leaves only ~3.8s of headroom
over the 20s bound, which is a modest, not comfortable, margin. The bound is
bounded by the 16 MiB raw report cap, but a craftier valid-token report could
still approach or exceed it. Verify with a production-like transfer and the
fresh hosted first-insert canary before relying on it; do not treat local 0.2 CPU
as production acceptance.

### Rollback

Applying the migration takes effect immediately at runtime (it is a runtime
`ALTER FUNCTION`, not a gated deploy), even though producer v2 stays OFF. The
change is an idempotent function setting with no data or schema change, so
rollback is a single statement per function and needs no downmigration:

```sql
-- restore the previous 8s bound (or re-run 20261116233148_seosmith_rpc_timeout.sql)
alter function public.ingest_seosmith_audit(text,uuid,text,text) set statement_timeout = '8s';
alter function public.import_seosmith_audit(uuid,text) set statement_timeout = '8s';
```

Roll back the API deadlines in the same change if reverting the whole PR
(`apps/api/src/websites.rs`: `import_seosmith_audit` back to the shared 10s and
`ingest_seosmith` back to 20s). An already-running statement is not shortened by
re-running the 8s migration; existing rows and bytes are untouched. Note that a
future `CREATE OR REPLACE FUNCTION` on either ingest function that omits the
`SET` clause would silently clear `proconfig` and reintroduce the 8s-or-role
default; keep the setting in the canonical definition or assert it in CI.
