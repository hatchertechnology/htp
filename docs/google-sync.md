# Scheduled Google reporting

Google Analytics dashboards and Search Console reports are collected by the
`google-sync` Supabase Edge Function and retained in Postgres. The Rust API reads
snapshots using the signed-in user's identity. Neither Fly application runs a
scheduler. URL Inspection remains an explicit live diagnostic; the CLI's existing
daily report endpoint also remains live and does not create snapshots.

## What is collected

- Each connected website with a saved GA4 property gets its trailing 28 complete
  UTC calendar days collected automatically, including summary, daily, top pages,
  channels, and devices. Google's property timezone still determines its metrics.
- Search Console properties are discovered hourly. The default matching property
  gets a trailing 28-day report: aggregate totals, daily rows, top 10 queries, and
  top 10 pages. Exact domain properties are preferred, then property URL order.
  Search results use finalized web-search data and Google's Pacific Time dates.
- Opening a different property/date range queues that exact report. It is refreshed
  hourly for seven days after its last request. At most 100 ranges can be active
  per website. Default collection continues without a dashboard visit.
- Original report bodies and response metadata are saved together. Unique users,
  rates, and rankings are never reconstructed by summing daily reports.

Every successful collection appends a snapshot to `google_report_snapshots`.
There is currently no automatic snapshot deletion. Deleting the website or user
cascades through its jobs and snapshots. Renaming a website or changing a GA4
binding isolates the previous reports; results for the old source are not served
under the new source. Disconnecting Google removes the encrypted refresh grant
and stops future work, while keeping report history. Signing out does not stop work.

## Scheduling and failure handling

Supabase Cron invokes the Edge Function **every minute** to drain due work; each
successful report is next due **one hour after completion**. This avoids making
new users wait for the next hourly tick. Each invocation processes up to twelve
jobs sequentially, starting new jobs only within a sixty-second budget. Bounded
HTTP timeouts leave time for the final job to complete within the function's
runtime limit. This lets a normal initial connection collect several websites
within one invocation. Larger queues continue on the next minute tick; default
windows for the preceding seven days also remain active during their refresh period.

Database claims use `FOR UPDATE SKIP LOCKED`, a three-minute lease, and a unique
lease token. Overlapping invocations cannot commit the same lease twice. Expired
leases become eligible for recovery; reconnects, disconnects, hostname changes,
and GA4 binding changes fence out an old worker's results. Failures use bounded
exponential backoff (one minute to one hour). OAuth `invalid_grant` marks the
connection as requiring reauthorization and pauses collection for that account.
Successful snapshots remain readable during provider failures and after disconnect.

The API returns HTTP 202 with `code: report_pending` before the first snapshot.
Saved responses include `sync` with `state`, `fetched_at`, `last_error`,
`next_run_at`, and `connection_status`. The dashboard checks pending work every
10 seconds and reads saved reports every minute while a connection is active.
Google errors are stored only as sanitized codes; tokens/provider error bodies
are never returned to clients or included in sync logs.

## Credentials and permissions

`google_connections` stores an AES-256-GCM encrypted refresh grant bound to the
Supabase owner ID through authenticated additional data. The same base64 32-byte
key must be configured as Nuxt's `NUXT_GOOGLE_COOKIE_KEY` and the Edge Function's
`GOOGLE_GRANT_KEY`. Preserve the existing Nuxt key during this migration. Key
rotation requires re-encryption of stored grants or user reconnection.

All three new tables have RLS enabled and are inaccessible to `anon` and
`authenticated`. The owner-checking `request_google_report` RPC is the only user
entry point. It validates a non-anonymous identity, website ownership, the saved
GA4 binding, dates, and the queue bound. Worker RPCs are executable only by
`service_role`. Worker URLs are fixed Google endpoints and Search Console
properties are validated against the website hostname before fetching data.

The Nuxt server needs `NUXT_SUPABASE_SERVICE_ROLE_KEY` for credential storage;
it must never be a `NUXT_PUBLIC_` variable. OAuth state remains in a secure,
encrypted, ten-minute HttpOnly cookie. A valid legacy Google grant cookie is
migrated on its next authenticated connection check. Other users must reconnect
once. An empty disconnected record prevents old cookies on another device from
silently restoring a deliberately disconnected account. Existing Google testing
mode grants may expire; production consent configuration still applies.

## Deployment

These are repository changes until the migration, function, secrets, Cron job,
Rust API, and Nuxt frontend have all been deployed. Deployment order:

1. Apply `supabase/migrations/20261030192526_google_report_sync.sql` to the existing
   project using your normal migration deployment process.
2. Configure Nuxt's server-only `NUXT_SUPABASE_SERVICE_ROLE_KEY`. Keep its existing
   Google web OAuth client credentials and encryption key.
3. Copy `supabase/functions/.env.example` to an ignored `.env` and fill it with the
   **same web OAuth client** and encryption key as Nuxt. Generate a separate random
   `GOOGLE_SYNC_SECRET` (`openssl rand -hex 32`). Set the Edge Function secrets:

   ```sh
   supabase secrets set --env-file supabase/functions/.env --project-ref raxuvdbdfmmtpqjcafcq
   supabase functions deploy google-sync --project-ref raxuvdbdfmmtpqjcafcq
   ```

   `verify_jwt = false` is intentional: the function checks the private
   `x-htp-sync-secret` header before using privileged credentials. A public API
   key or user JWT cannot authorize the updater.
4. In Supabase Vault, create `htp_project_url` with the project URL and
   `htp_google_sync_secret` with the identical `GOOGLE_SYNC_SECRET`. Use the
   Dashboard Vault UI rather than pasting secrets into committed SQL. Then run
   `supabase/cron/google-sync.sql` in the SQL editor. Re-running it replaces the
   named Cron job without creating duplicates.
5. Deploy the Rust API and Nuxt frontend together. Connect or reconnect Google.
   The next minute tick discovers properties and collects the default reports;
   reports appear as their jobs complete.
6. Check `cron.job_run_details`, Edge Function logs, and `google_report_jobs`
   (`last_error`, `next_run_at`, `leased_until`). Confirm that snapshots increase
   and that the dashboard shows a last-sync timestamp. Cron's HTTP submission
   succeeding alone does not prove the Edge Function completed successfully;
   inspect `net._http_response` when diagnosing invocation failures.

Supabase's [scheduling guide](https://supabase.com/docs/guides/functions/schedule-functions)
documents the Cron + pg_net + Vault pattern.

## Local verification

```sh
cargo test --workspace
npm --prefix apps/web test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npm --prefix supabase ci
npm --prefix supabase test
deno check supabase/functions/google-sync/index.ts
deno test --allow-env supabase/functions/google-sync
```

Database tests apply the actual migrations to a disposable PostgreSQL runtime
(PGlite), then exercise user/service privileges, source validation, leases,
snapshot history, failure recovery, and disconnects. This does not replace a
hosted smoke test of Cron, Vault, Google consent, and the deployed function.
