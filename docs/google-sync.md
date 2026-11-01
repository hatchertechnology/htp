# Scheduled Google reporting

Google Analytics dashboards and Search Console reports are collected by the
`google-sync` Supabase Edge Function and retained in Postgres. The Rust API reads
snapshots using the signed-in user's identity. Neither Fly application runs a
scheduler. URL Inspection remains an explicit diagnostic of Google's indexed
version, with successful observations retained in append-only history. The CLI's
existing daily report endpoint remains live and does not create snapshots.

## What is collected

- Each connected website with a saved GA4 property gets its trailing 28 complete
  UTC calendar days collected automatically, including summary, daily, top pages,
  channels, and devices. Google's property timezone still determines its metrics.
- Search Console properties are discovered hourly. The default matching property
  gets a trailing 28-day report: separate aggregate totals, daily rows, bounded
  query/page/query+page datasets, and device/country breakdowns. Each large
  dataset requests 1,000 rows at a time up to 5,000 retained rows. Exact domain
  properties are preferred, then property URL order.
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

## Site health, conversions, and Business Profile

The `google_site_insights` migration extends the same queue, fencing, and snapshot
storage. Deploy this migration before the updated worker, API, and web app.
Existing Analytics/Search reports and the live URL Inspection diagnostic continue
to work. No dashboard report request calls Google: the new Rust insight routes
use user-scoped database RPCs; the Edge Function is the only report collector.

| Source | Collection | Stored data |
| --- | --- | --- |
| PageSpeed Insights | Daily, mobile and desktop | HTTPS homepage Lighthouse categories, audit diagnostics, version, test time and URL; embedded screenshots are omitted |
| Chrome UX Report | Daily, PHONE and DESKTOP | Origin-level LCP, INP, CLS percentiles and collection periods, or an explicit insufficient-data observation |
| GA4 conversions | Hourly, selected dates plus automatic trailing 28 complete UTC dates | Separate aggregate totals/rate/revenue, daily outcomes, up to 100 landing pages/channels/event names, original headers and metadata |
| Business location discovery | Hourly | Authorized locations across paginated Google accounts; users explicitly link relevant locations to a website |
| Business Profile contents | Hourly for linked locations | Name, categories, phones, address, website, hours, service area, open status, description, services, labels, coordinates and attributes |
| Business Profile performance | Hourly, selected dates plus trailing 28 complete UTC dates | Daily Search/Maps impressions by device, website clicks, call-button clicks and direction requests |

Set `GOOGLE_PAGESPEED_KEY` and `GOOGLE_CRUX_KEY` in the Edge Function secrets and
enable their respective APIs in Google Cloud. Keys are not browser configuration.
Google OAuth credentials are not used for public PageSpeed/CrUX calls. Collection
still follows the account connection lifecycle: disconnect stops all jobs, while
saved data stays available. Missing keys are stored as `integration_not_configured`;
public-key authentication failures never revoke the account's OAuth connection.

Business Profile requires Google project approval and the Account Management,
Business Information, and Business Profile Performance APIs. Reconnect Google to
authorize `https://www.googleapis.com/auth/business.manage`. Google does not offer
a narrower reporting-only scope for these calls; Hatch uses only GET/report reads,
and never edits a Google profile. Consent may be granted separately for each
service. Enable APIs and complete Google's approval/consent requirements before
claiming live Business Profile availability. Existing grants continue to collect
Analytics/Search without the new scope.

A website supports up to 50 tracked locations. `set_business_location` checks
ownership and verifies that the requested resource was discovered by the worker;
clients cannot inject provider results. Unlinking stops future work and fences
in-flight writes, retaining previous observations. A website rename isolates its
bindings and report history from the previous hostname. Reports are service-only
with RLS enabled; only ownership-checking RPCs expose saved data.

Every successful profile read appends an observation. A separate
`google_profile_changes` record stores each changed top-level field's before and
after JSON, the old/new snapshot IDs, and both observation timestamps. The first
observation is explicitly marked `__baseline`, not an edit. Unordered profile
arrays are normalized to avoid artificial edits; ordered address lines retain
their order. Identical observations do not add changes. Failures add no profile
observations or inferred deletions. Actual edit timestamps, actors, changes
between polls, and profile history before tracking began are unavailable.

`POST /websites/{id}/insights/report` reads/queues a saved source; static
observations (PageSpeed, CrUX, discovery, profile contents) share a fixed job rather
than separate jobs per viewing range. `POST /websites/{id}/insights/history` reads
observations collected within the requested **UTC observation dates**, with
`before_id` pagination (200 observations plus a continuation indicator). The
history response omits PageSpeed audit payloads and duplicate full profiles;
original snapshots remain in the database, and profile change records contain
the before/after values. History dates are collection dates, not the date ranges
inside performance reports. The default dashboard ends yesterday; include today
when examining newly collected profile or site-health observations.

The profile comparison table reads matching-date saved Analytics, conversion,
Search, and Business Profile daily reports from the database, along with that UTC day’s latest mobile PageSpeed test and CrUX observation. Daily performance
metrics retain provider dates: GA4 property timezone, Search Console Pacific time,
and Business Profile location dates. Profile observations use UTC; same-day
alignment is approximate. These are comparisons, not causal claims. Missing local
metrics are shown as unavailable rather than fabricated zeroes. Call clicks do
not prove answered calls, and GA4 conversions depend on configured key events.
CrUX observations have overlapping 28-day windows and may be unavailable for
small sites. PageSpeed scores are lab tests and can vary between runs.

No automatic historical deletion is introduced. Existing snapshot retention and
website/user deletion cascades apply. Operational rollout still requires applying
the migration, configuring API keys/Google API approvals, deploying all three
services, reconnecting consent, and selecting locations. Unit/fixture tests do
not verify production Google API access, Cron delivery, or real customer tracking.

Provider references: [PageSpeed](https://developers.google.com/speed/docs/insights/v5/reference/pagespeedapi/runpagespeed),
[CrUX](https://developer.chrome.com/docs/crux/api),
[GA4 metrics](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema),
[Business Information](https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations),
[Business performance](https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries).

## Temporary Business Profile pause

Business Profile collection and UI are disabled pending Google Basic API Access
approval: https://github.com/hatchertechnology/htp/issues/2. Other Google reports
continue to run. The database gate `public.business_profile_enabled()` returns
false: no Business Profile jobs are seeded or claimed, and report requests and
location linking are rejected. Existing jobs, location links, snapshots, and
change records are preserved, and saved history remains readable.

After approval, add a migration replacing that function to return true, set
`businessProfileEnabled` in `apps/web/shared/utils/features.ts` to true, update the
OAuth consent test, and deploy the web app. This restores the existing dashboard,
navigation, connection details, permission requests, and collection without
rebuilding the integration. Confirm nonzero API quotas before re-enabling it.

## Search and outcome evidence (H05)

Search snapshots add versioned `measurement`, per-dataset `collection`,
`previous_period`, and `analysis` fields while preserving the existing report
keys. The preceding adjacent period has the same inclusive duration. Comparison
requires matching property, hostname policy, finalized data, confirmed observed
end dates, and usable aggregate evidence; otherwise it carries an unavailable
reason. A missing final daily row is inconclusive, because Google can omit days
without data. These comparisons do not establish seasonality or causal effects.

Search Console returns bounded top rows and excludes anonymized queries from
query dimensions. Reaching the end of pagination does not establish a complete
URL/query inventory. `truncated` identifies the local row ceiling; provider
completeness remains `not_guaranteed`. Separate aggregate totals must not be
reconstructed by summing query/page rows. Dates use Google's Pacific Time.
Device and country datasets are independent breakdowns, not a joint segment.
See the [Search Analytics API contract](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).

Analysis semantics version 1 emits review candidates with the original observed
rows: low CTR/zero clicks at 100+ impressions and CTR below 2%; query overlap when
two observed pages each have 10+ impressions; and aggregate click decay of 20%+
from a preceding period with 20+ clicks. These thresholds are review heuristics,
not defects, ranking guarantees, or evidence of harmful competition. Legacy
snapshots remain readable; absent provenance must not be interpreted as complete
coverage or zero outcomes. GA4 landing outcomes retain source metrics and their
collection limits, with no attribution to individual Search Console queries.

URL inspection records Google's indexed version, never a live indexability test
or indexing request. Successful observations preserve the property, requested
URL, collection time, and response. History is owner-scoped and hostname-scoped;
renames isolate earlier observations. Records submitted through an authenticated
RPC have explicit owner-submitted provenance, not a cryptographic Google
attestation. See the [URL Inspection API contract](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect).

Deploy the inspection-history migration before the Rust API, then deploy the
updated `google-sync` worker. Collection uses the existing Google scopes, leases,
and hourly refresh; no new external credentials or automatic inspections are
introduced. Roll back application/worker binaries to stop producing additive
fields while retaining immutable history and the additive schema. No production
deployment or provider-volume validation is implied by local fixtures.

This delivery is a foundation for issue #10. Device/country filters are not yet
caller-selectable; the new datasets are aggregate breakdowns. Cross-source
search-to-GA4 attribution, page-level decay scoring, and crawl correlations remain
follow-up work. Current landing outcomes are the bounded GA4 landing-page report.

The Search dashboard polling response projects summary/daily data, measurement
provenance and ten query/page rows; each table records presentation truncation.
Full datasets, prior-period evidence and analysis remain in immutable snapshots
available through owner-scoped saved-data API/MCP reads. A default range ending
yesterday may lack finalized observations and correctly remains inconclusive;
request an older finalized range for comparison rather than silently shortening
one period or treating absent days as zero traffic.
