# Bing Webmaster reporting

Hatch connects a user's Bing Webmaster account with the `webmaster.read` OAuth
scope. It reads reports only: no URL submission, IndexNow, sitemap edits, crawl
configuration changes, site registration, or verification writes are performed.

## Data and dashboard

The independent `bing-sync` Edge Function discovers verified root properties for
each owned website using `GetUserSites`. Matching requires the exact hostname;
`example.com` and `www.example.com` are separate. HTTPS wins over HTTP, with URL
order breaking ties. Subdirectory properties are excluded because they do not
represent the whole website. Only property URL and verified state are saved;
verification codes from discovery are omitted. No matching property is saved as
an explicit successful discovery observation and checked again the next day.

For the selected property, each daily observation stores these original rows:

| Section | Bing method | Dashboard interpretation |
| --- | --- | --- |
| Traffic | `GetRankAndTrafficStats` | Daily clicks/impressions and computed CTR for returned rows in the selected dates |
| Queries | `GetQueryStats` | Latest provider rows with their dates, clicks, impressions, computed CTR and average impression position |
| Pages | `GetPageStats` | Same dated provider table for page URLs |
| Crawl | `GetCrawlStats` | Latest provider date's index/crawl/error/block/link counts |
| Issues | `GetCrawlIssues` | Current provider list with URL, HTTP status and decoded issue flags |
| Sitemaps | `GetFeeds` | Current top-level feeds with status, last crawl and URL count |

Bing's endpoints do not accept the Google dashboard's arbitrary date ranges.
Only the traffic chart and its totals use that filter. Query/page tables show up
to 20 rows, newest provider dates first and then highest clicks. They are not
represented as aggregates for the selected period. Crawl, issues, and sitemaps
also show provider observations independently of the filter. All returned rows
are retained in storage and available through MCP, including rows beyond the UI
limits. Microsoft JSON dates preserve their provider-local calendar dates.
Unknown numeric values and missing days remain unavailable. CTR is calculated
only from valid returned clicks and impressions. Rankings are not summed.

Bing documents daily traffic/crawl updates and weekly query/page updates. Daily
collection is a retrieval cadence, not a promise of newly processed data. Overall
traffic combines Bing search surfaces and must not be compared as if it were
Google's finalized web-only report. AI Performance/Copilot citation reports are
not included because no public endpoint was verified.

Each section can independently fail. A partial observation saves successful
sections with sanitized error codes for failed sections. The dashboard explicitly
marks those sections unavailable. If every section fails, no observation is saved
and the last successful observation stays readable. Provider fault bodies and
OAuth tokens never reach the dashboard or sync logs. Partial observations do not
silently splice old section rows into a new observation.

## Storage and scheduling

`bing_connections`, `bing_report_jobs`, and `bing_report_snapshots` have RLS enabled
and are service-only. `request_bing_report` verifies non-anonymous ownership and
returns the latest observation and sync metadata. Rust serves this via
`POST /websites/{id}/bing/dashboard`; Nuxt proxies it using only the user's HTP
identity. Reading a report does not call Bing or make the daily refresh due early.

Cron invokes the function every minute to drain due jobs. The worker starts up to
six jobs within a sixty-second start budget. Requests have bounded timeouts; six
report sections run concurrently after discovery. Each success is due again one
day later. Failures use exponential backoff from one minute to one hour. Claims
use SKIP LOCKED, a three-minute lease and a random fencing token. Expired leases
are recoverable, and duplicate/late completion cannot append a snapshot.

Encrypted refresh grants use AES-256-GCM with authenticated owner/provider
binding. Access tokens are request-local. Rotated refresh tokens are persisted
against the connection generation before saving reports. OAuth state is encrypted,
HttpOnly, expires in ten minutes and is checked before exchanging the code.
Bing's documented OAuth flow does not specify PKCE, so no PKCE support is assumed.

Connecting again changes the generation, invalidates prior work and makes jobs
due immediately. Disconnecting clears the grant, invalidates work and stops
collection across devices; saved observations remain readable. An invalid refresh
grant marks the connection as requiring reauthorization. Website renames isolate
previous hostname observations; website/user deletion cascades to jobs/snapshots.
There is no automatic retention deletion.

The MCP `website_saved_data` tool supports `bing_sources` and `bing_snapshots`.
Both follow the existing `limit`, `job_id`, `before_id`, `has_more`, and
`next_cursor` contracts. Snapshot IDs are a separate sequence from Google, so
never reuse cursors between datasets. The `sources` response advertises the extra
Bing datasets. These reads do not enqueue jobs or require Bing credentials.

## Deployment

1. Register a Bing Webmaster OAuth client under **Settings → API Access → OAuth
   Client**. Set its redirect URI to the public app origin plus
   `/auth/bing/callback`. Sites must already be verified in the connected account.
2. Apply `20261031024557_bing_reporting.sql` after the existing migrations.
3. Configure server-only Nuxt variables `NUXT_BING_CLIENT_ID`,
   `NUXT_BING_CLIENT_SECRET`, and `NUXT_BING_COOKIE_KEY`. Generate a fresh base64
   32-byte encryption key with `openssl rand -base64 32`. Keep the existing
   `NUXT_APP_ORIGIN` and `NUXT_SUPABASE_SERVICE_ROLE_KEY` correctly configured.
4. Configure Edge Function secrets `BING_CLIENT_ID`, `BING_CLIENT_SECRET`,
   `BING_GRANT_KEY` (identical to `NUXT_BING_COOKIE_KEY`) and a separate random
   `BING_SYNC_SECRET`. Use a dedicated ignored env file, without blank Google
   entries, when setting Bing secrets. Hosted Supabase supplies the project URL
   and service-role key.
5. Deploy `bing-sync` with the existing CLI deployment process. `verify_jwt=false`
   is deliberate: the function checks the private `x-htp-sync-secret` header.
   Public publishable keys and user JWTs cannot authorize collection.
6. Save `htp_bing_sync_secret` in Supabase Vault with the same `BING_SYNC_SECRET`;
   reuse the existing `htp_project_url`. Run `supabase/cron/bing-sync.sql` to install
   the independent `htp-bing-sync` minute tick. This does not alter Google Cron.
7. Deploy the Rust API and Nuxt frontend together. Connect Bing under Connections.
   Confirm snapshots increase and the dashboard's last-sync timestamp appears.
   Check Cron delivery, `net._http_response`, Edge logs and job `last_error` when
   diagnosing failures. A submitted Cron HTTP request is not proof of completion.

Credentials, migrations, function deployment and Vault/Cron configuration are
required before production reporting works. Local tests use fixtures; they do
not validate Microsoft's live consent or API access for a real account.

## Verification

```sh
cargo test --workspace
npm --prefix apps/web test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
npm --prefix supabase test
deno check supabase/functions/bing-sync/index.ts
deno test --allow-env supabase/functions/bing-sync
deno lint supabase/functions/bing-sync
```

Database tests apply all real migrations to disposable PGlite and exercise
ownership, service-only credentials, automatic scheduling, leases/recovery,
disconnect/reconnect fencing, retained snapshots, hostname isolation and MCP
pagination. Worker fixtures cover official JSON methods, exact-host matching,
partial errors, fault codes, token rotation and Nuxt-compatible encryption.
Browser verification uses fixture account/data responses, not real Bing tokens.

References: [OAuth](https://learn.microsoft.com/en-us/bingwebmaster/oauth2),
[API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi?view=bing-webmaster-dotnet),
[Traffic semantics](https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi.getrankandtrafficstats?view=bing-webmaster-dotnet),
[API faults](https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.apierrorcode?view=bing-webmaster-dotnet).
