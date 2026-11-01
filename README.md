# htp
The Hatch Tech Platform. Tool for managing client online work. 

## Workspace

```text
apps/api/       htp-api: HTTP server
apps/cli/       htp-cli: command-line HTTP client
crates/shared/  htp-shared: shared JSON response types
apps/web/       Nuxt + Nuxt UI frontend (independent npm app)
```

Both apps import `MessageResponse` from `htp-shared`. The API serializes it
as JSON, and the CLI deserializes the response into the same type.

Requires Rust 1.88 or newer (the MCP SDK's minimum supported version).

## Run the API

Run the Rust HTTP server:

```sh
cargo run -p htp-api
```

Request the endpoint from another terminal:

```sh
curl http://127.0.0.1:3000/
```

`GET /` returns HTTP `200 OK` with `Content-Type: application/json`:

```json
{"message":"hello world"}
```

## Run the CLI

With the API running, open another terminal:

```sh
cargo run -p htp-cli
```

Output:

```text
hello world
```

Choose a different endpoint or see help:

```sh
cargo run -p htp-cli -- --url http://127.0.0.1:3000/
cargo run -p htp-cli -- --help
```

The message command times out after 10 seconds and exits with a nonzero status on connection,
HTTP, or JSON errors. Errors go to stderr; the message goes to stdout.

## Development

```sh
cargo build --workspace
cargo test --workspace
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

Each app can also be run from its own directory with `cargo run`. All members
share the root `Cargo.lock` and `target/` directory.

## Deploy the API to Fly.io

Fly deployment files live with the API in `apps/api/`. Run deployment commands
from the **workspace root**, so the Docker build can include the shared crate:

```sh
fly auth login
fly deploy --config apps/api/fly.toml --remote-only --ha=false
```

The Dockerfile builds only `htp-api` in release mode, then copies the binary
into a small runtime image running as a non-root user. The API defaults to
`127.0.0.1:3000` locally; `BIND_ADDR` overrides its listening address, and Fly
sets it to `0.0.0.0:3000` so its proxy can reach the service.

The deployment uses one shared CPU with 256 MB RAM in Ashburn (`iad`), enforces
HTTPS, checks `GET /`, and automatically stops when idle and starts on requests.
An idle app may take a moment to wake. Website persistence uses Supabase; no Fly persistent volume is needed.

Verify the deployed endpoint and call it from the CLI:

```sh
curl --fail https://htp-api-kerry-hatcher.fly.dev/
cargo run -p htp-cli -- --url https://htp-api-kerry-hatcher.fly.dev/
fly status --config apps/api/fly.toml
fly checks list --config apps/api/fly.toml
```

To deploy under a different app name, create an app with `fly apps create NAME`,
update `app` in `apps/api/fly.toml`, then deploy from the workspace root.

Official Fly.io documentation:

- [Dockerfile deployments](https://docs.fly.io/languages-and-frameworks/dockerfile)
- [App configuration and health checks](https://docs.fly.io/reference/configuration)
- [Monorepo deployments and build context](https://docs.fly.io/launch/monorepo)
- [Automatic stop/start](https://docs.fly.io/launch/autostop-autostart)

## MCP endpoint

The API exposes Streamable HTTP MCP at `/mcp` using the
[official Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk).
Connect an MCP client to:

- Local: `http://127.0.0.1:3000/mcp`
- Fly: `https://htp-api-kerry-hatcher.fly.dev/mcp`

The public endpoint requires no authentication and exposes one read-only tool,
`hello_world`, with no arguments. Its structured result is
`{"message":"hello world"}`, also included as JSON text for client compatibility.
The REST route and MCP tool share the same response function and type.

The transport is stateless and returns JSON for ordinary requests. Clients can
initialize and call `tools/list` and `tools/call` without a session ID, so machine
restarts do not invalidate sessions. A browser `GET /mcp` is not a tool call.

For example, call the tool with a Streamable HTTP request:

```sh
curl --fail https://htp-api-kerry-hatcher.fly.dev/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello_world","arguments":{}}}'
```

`MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` are comma-separated allowlists.
Local defaults allow loopback hosts and origins on port 3000; `fly.toml` sets
the deployed hostname and HTTPS origin. Requests without an `Origin` header
are supported. When adding a custom domain or browser client, update these
allowlists to include its host and origin.

## Supabase authentication

This app uses the [htp Supabase project](https://supabase.com/dashboard/project/raxuvdbdfmmtpqjcafcq)
at `https://raxuvdbdfmmtpqjcafcq.supabase.co`. `SUPABASE_URL` can override the
project URL locally; Fly sets it explicitly in `apps/api/fly.toml`.

The additional secured routes require a **signed-in user's access token**:

| Interface | Endpoint | Operation |
| --- | --- | --- |
| REST | `GET /secured` | Return the secured greeting |
| MCP | `/mcp/secured` | Discover websites and read complete saved SEO evidence, report sources, profile changes and repository history |

Both return `{"message":"hello world secured"}` (in `structuredContent` and
text content for MCP). The existing `GET /` and `/mcp` remain public. The secured
tool is available only on the protected MCP endpoint. Authentication applies to
every request, including MCP initialization and tool discovery.

Sign in through Supabase Auth and use the session's `access_token`, for example
`data.session.access_token` from `supabase.auth.signInWithPassword(...)`.
The linked project currently supports email/password sign-in and requires email
confirmation for new signups. A publishable key identifies the Supabase project;
it is **not** a user access token. No service-role key or JWT signing secret is
needed by the API.

With `SUPABASE_ACCESS_TOKEN` set to the user's token:

```sh
curl --fail https://htp-api-kerry-hatcher.fly.dev/secured \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"

curl --fail https://htp-api-kerry-hatcher.fly.dev/mcp/secured \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello_world_secured","arguments":{}}}'
```

For an MCP client, configure the protected URL and send the same `Authorization`
header on every request. This implements bearer-token access using an existing
Supabase session; an interactive OAuth login/consent flow is not included.

The API verifies ES256/RS256 signatures against the project's fixed JWKS URL,
requires the project's issuer and `authenticated` audience, checks expiration
and any `nbf` claim, and requires a non-anonymous `authenticated` user with a
nonempty UUID. It never uses editable user metadata for authorization. Public
keys are cached for five minutes; unknown key IDs trigger a refresh at most
once per 30 seconds. The token's `jku` or similar headers cannot select the
verification server.

Missing or invalid tokens receive HTTP `401` and `WWW-Authenticate: Bearer`.
A failed signing-key fetch receives `503`; protected handlers are never run
when validation fails. Protected responses use `Cache-Control: no-store`.
JWT validation does not check current session revocation: a signed access token
can remain valid until it expires, and key revocations can take effect after
the JWKS cache expires. Use short access-token lifetimes as appropriate.

See [Supabase JWT verification](https://supabase.com/docs/guides/auth/jwts)
and [JWT claims](https://supabase.com/docs/guides/auth/jwt-fields).

## Web frontend

The Nuxt 4 and Nuxt UI 4 application lives in `apps/web`. It includes a REST
playground, MCP tool discovery and calls, a JSON response viewer, a connection
guide, and Supabase email/password sign-in, account creation, and sign-out.
It restores and refreshes browser sessions automatically. Secured requests
include the signed-in user's access token; public requests do not send it.

Run it with Node.js 22.12+ (Node 24 LTS recommended):

```sh
cd apps/web
npm ci
npm run dev
```

Open `http://localhost:3001`. Defaults already target the deployed Fly API and
the linked Supabase project. No private API keys are required. Optional overrides
are listed in `apps/web/.env.example`. To use a local Rust API, set both
`NUXT_API_BASE_URL` and `NUXT_PUBLIC_API_BASE_URL` to `http://127.0.0.1:3000`.

The browser sends requests to a same-origin Nuxt server route. That route only
forwards to the configured API's fixed routes, so no CORS changes
are needed in the Rust app. It preserves error status codes and uses `no-store`.
The API remains responsible for validating bearer tokens. Supabase credentials
in public runtime configuration are publishable client keys, not service-role keys.

Account creation requires email confirmation. Confirmation links use the
Supabase project's configured Site URL; after confirming, return to the frontend
and sign in. For a hosted frontend, configure the project's Site URL to its
public URL in Supabase Authentication → URL Configuration.

Frontend checks and production commands:

```sh
cd apps/web
npm run typecheck
npm test
npm run build
PORT=3001 npm start
```

The frontend has its own Dockerfile and Fly configuration. Its Docker build
context is `apps/web`, unlike the API's workspace-root build context:

```sh
fly apps create htp-web-kerry-hatcher
fly deploy apps/web --config fly.toml --remote-only --ha=false
```

The Cargo workspace continues to build only the Rust crates. Frontend dependencies
and build output are excluded from the API's Docker build context.

## Website records

Open `/websites` in the frontend and sign in to add, list, rename, and delete
website records. A record contains a full domain name such as
`www.dreamcleanmacon.com`; it does not store website content. Domains are
normalized to lowercase ASCII (IDNA), and duplicate domains within one account
are rejected. URLs, paths, ports, and IP addresses are not accepted.

The authenticated REST routes are:

| Method | Route | Result |
| --- | --- | --- |
| GET | `/websites?limit=50&offset=0` | `{items, has_more}`; limit 1–100 |
| POST | `/websites` | Create from `{ "fqdn": "www.example.com" }` |
| GET | `/websites/{id}` | Read one record |
| PATCH | `/websites/{id}` | Update its `fqdn` |
| DELETE | `/websites/{id}` | Delete the record; HTTP 204 |

Send a Supabase user access token as `Authorization: Bearer …`. Responses contain
`id` and `fqdn`. Supabase row-level security isolates records by signed-in user;
client relationships and other metadata can be added later. The API forwards the
user token with the public publishable key, so database policies also apply to
API requests. Anonymous accounts are excluded.

The migration `supabase/migrations/20261028142440_create_websites.sql` is already
applied to the linked Supabase project. The first record,
`www.dreamcleanmacon.com`, was added to the existing user's account separately
from the reusable migration. The CRUD API is deployed on Fly; the frontend is
available locally on port 3001.

## Google Analytics (Google account OAuth)

The API and CLI can fetch a daily GA4 report for a saved website. Reports include
`activeUsers`, `sessions`, and `screenPageViews`, grouped by `date`, filtered to
that record's exact `hostName`. For example, `www.dreamcleanmacon.com` does not
include traffic to the bare domain or other subdomains. Empty reports are valid;
this integration reads existing GA4 data and does not install tracking tags.

### Connect your Google account

This checkout has a Google Cloud project named **Hatch Tech Platform**
(`vibrant-fabric-513015-m1`), with the Analytics Data API enabled and a Desktop
OAuth client named **HTP CLI**. Its downloaded client configuration is stored
privately in `.local/google-client-secret.json` (excluded from Git and Docker).
To use it from the workspace root:

```sh
cargo run -p htp-cli -- analytics --token-file .local/google-oauth.json login \
  --client-secrets .local/google-client-secret.json
```

Use the same `--token-file .local/google-oauth.json` option for subsequent report
and logout commands. Google account consent is required before reports can run.
For a separate installation, create your own OAuth client as described below.

1. In your Google Cloud project, enable the **Google Analytics Data API**.
2. Configure the Google Auth Platform consent screen for your application. If
   using an external app in testing mode, add your Google account as a test user.
3. Create an OAuth client with application type **Desktop app**, and download
   its client JSON to a private location outside this repository. A Web application
   client is not compatible with this CLI's loopback callback.
4. Ensure the Google account you sign in with has at least Viewer access to the
   GA4 property. Find its numeric property ID in Analytics Admin → Property details.
   This is different from the `G-…` measurement ID.
5. Connect from your own desktop terminal:

```sh
cargo run -p htp-cli -- analytics login \
  --client-secrets /absolute/path/to/client_secret_download.json
```

The CLI opens your system browser on Linux/macOS and also prints the sign-in URL.
Use `--no-browser` to open the URL yourself. Complete consent within ten minutes
on the same computer as the CLI. The flow uses PKCE (S256), a random checked state,
and an ephemeral `127.0.0.1` loopback listener. It requests only
`https://www.googleapis.com/auth/analytics.readonly` with offline access.

Refresh credentials are stored locally in `$XDG_CONFIG_HOME/htp/google-oauth.json`
(or `$HOME/.config/htp/google-oauth.json`), with file permissions `0600` on Unix.
They are not encrypted at rest; protect this file as a credential. Override the
location using `analytics --token-file /private/path/google-oauth.json …`.
The CLI refreshes the access token when fetching a report; neither the refresh
token nor the OAuth client secret is sent to HTP. Google testing-mode grants may
expire and require sign-in again.

### Pull a website report

Set `HTP_ACCESS_TOKEN` in your shell to your Supabase user access token. It must
belong to the owner of the website record. Google authorization and HTP sign-in
are separate: both are required. Then run:

```sh
cargo run -p htp-cli -- --url https://htp-api-kerry-hatcher.fly.dev/ \
  analytics --token-file .local/google-oauth.json report \
  --website 0466811c-c4ad-40f2-8651-ca5ee27e653c \
  --property 557292489 \
  --start-date 2026-10-01 --end-date 2026-10-27
```

The website UUID above belongs to the existing `www.dreamcleanmacon.com` record.
Property `557292489` is the GA4 property supplied for this website.
The property ID must be provided; a domain name does not identify a GA4 property.
Dates are inclusive and interpreted by Google in the property's timezone. The
range is limited to 366 days. When omitted, CLI dates default to 30 days ago
through yesterday, calculated from the current UTC date. Daily users/sessions
should not be summed to infer distinct users/sessions across the whole period.

Output is JSON on stdout, suitable for redirection to a file. Errors go to stderr
and return a nonzero exit status. The original Google report is nested under
`report`, preserving column headers, timezone, row count, thresholding/sampling
metadata, and empty results. Reports are fetched on demand, not saved to the database.

The CLI sends the short-lived Google access token to the chosen HTP API. Use only
a trusted API origin; HTTPS is required except for local loopback development.
Redirects are disabled. The API checks website ownership via user-scoped Supabase
RLS, then queries the fixed Google Analytics endpoint with the Google token.
It does not retain the Google token or return it in responses. Responses are
`Cache-Control: no-store`. No Google server secrets or database migration are
required for this integration. The report request timeout is 35 seconds; Google
upstream requests time out after 20 seconds.

To disconnect locally:

```sh
cargo run -p htp-cli -- analytics --token-file .local/google-oauth.json logout
```

This removes the local token file. To revoke the grant at Google as well, remove
the app in your Google account's connected apps. Other devices' grants remain
until revoked at Google.

### REST contract

`POST /websites/{website_uuid}/analytics`

Headers:
- `Authorization: Bearer <Supabase user access token>`
- `X-Google-Access-Token: <Google OAuth access token>`
- `Content-Type: application/json`

Body:

```json
{
  "property_id": "123456789",
  "start_date": "2026-10-01",
  "end_date": "2026-10-27"
}
```

A successful response contains `website: {id, fqdn}`, `property_id`, `start_date`,
`end_date`, and `report` (Google's RunReportResponse). Requests cannot supply a
hostname override or upstream URL. Missing/inaccessible websites return 404.
Invalid dates/JSON return 422; invalid ranges/property IDs return 400. Google
expired-token, denied-access, quota, and upstream failures return 401, 403, 429,
and 502 respectively, with a stable `code` and sanitized `error`. A Google-rejected
property/report returns 400. Tokens and provider error bodies are not echoed.

Official references: [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Data API setup](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart),
[runReport](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport),
and [dimensions and metrics](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema).


### Website performance dashboard

The Nuxt application is deployed at https://htp.hatchtech.dev. Sign in, add a
website under Websites, and use its Analytics action to save the numeric GA4
property ID. Connect your Google account under Connections, then select the
website and date range on Overview. The dashboard displays aggregate users,
sessions, views, engagement, daily traffic, channels, top pages, and devices.
Every Google report is filtered to the website's exact hostname. Dashboard
reports are collected hourly by a Supabase Edge Function and saved as database
snapshots. The API reads saved reports; new date ranges are queued for collection.
See [scheduled Google reporting](docs/google-sync.md) for deployment and operation.

Dashboard OAuth uses a separate Google **Web application** client with callback
`https://htp.hatchtech.dev/auth/google/callback` (development:
`http://localhost:3001/auth/google/callback`). Configure the server-only variables
in `apps/web/.env.example`; keep the cookie encryption key stable across deploys.
The server validates the Supabase identity and saves the Google refresh grant
encrypted in a service-only database table, bound to that user. Scheduled updates
continue while signed out. Disconnect removes the grant across all devices and
stops updates; saved reports remain. OAuth state uses a short-lived HttpOnly
cookie. Existing browser grants migrate on their next authenticated connection
check. Revoke the application in Google to revoke the grant at Google as well.
The Google OAuth application currently runs in testing mode, so Google access
is limited to configured test users.

The Rust dashboard endpoint is `POST /websites/{id}/analytics/dashboard`, with
the same authentication and request body as the daily report contract above.
It requires the request's property to match the saved website
property and an HTP bearer token; no Google access token is required. It returns
the latest saved snapshot with `sync` freshness metadata and five reports under `report`: summary, daily, pages, channels,
and devices. Before the first sync it returns HTTP 202 with
`code: report_pending`. Set the binding using `PUT /websites/{id}/analytics/property` with
`{"property_id":"557292489"}` or null to unlink. Both operations enforce ownership.

Deploy the frontend from `apps/web` using `fly deploy --remote-only --ha=false`.
The Fly app is `htp-web-kerry-hatcher`; its Google server credentials are Fly
secrets. DNS points `htp.hatchtech.dev` directly to that Fly application.

A confirmed test account was created for dashboard verification. Its credentials
are stored only in the ignored, permission-restricted local file
`.local/dashboard-test-user.json`; they are not included in source or images.

### Google Search workspace

The overview leads with Google Search performance and keeps GA4 reports below.
The shared website and date range apply to both sources; each loads independently.
Connect or extend Google under **Connections** after deploying the Rust API and
Nuxt frontend together. Existing Analytics cookies remain valid for GA4 but need
renewed consent for Search Console. Granular consent is respected per service.

Enable the Google Search Console API (`searchconsole.googleapis.com`) in the
Google Cloud project that owns the web OAuth client. URL Inspection is included
in that API. Keep Google Analytics Data API enabled for existing onsite reports.
Add `https://www.googleapis.com/auth/webmasters.readonly` to the OAuth consent
configuration alongside `https://www.googleapis.com/auth/analytics.readonly`.
Authorize test users if the Google application is still in testing mode.

The existing server-only Google OAuth configuration is reused. Scheduled reporting
adds a migration, `NUXT_SUPABASE_SERVICE_ROLE_KEY`, matching Edge Function secrets,
and a Supabase Cron job; follow [the deployment steps](docs/google-sync.md). All connections are read-only and use
the signed-in user's Google credentials; Hatch does not use a shared Google account.

Search Console properties are discovered from the connected account. Domain
properties may cover the selected hostname or its parent domain; URL-prefix
properties must match the selected hostname. Reports filter pages to the selected
exact hostname. The selector lists verified properties accessible to the Google
user. Discovery and Search reports are retained as hourly database snapshots.

Search reports use web search and finalized data in Pacific Time. Recent days may
not yet be available. Totals come from a separate aggregate query, never from sums
of ranked queries. Top queries and landing pages are capped at 10 rows; Google may
omit anonymized queries. Dates without a returned row are not presented as known
zeroes. GA4 uses its property's timezone, so sources need not agree.

URL Inspection reads Google's indexed version of one URL, including crawl,
robots, fetch, and canonical status. It is not a live test or a request to crawl a
page. A landing-page row fills the URL tool. Switching website, property, or URL
clears previous inspection results.

Authenticated Rust routes (all `POST`, scoped through the owner's website):

| Route | Body | Result |
| --- | --- | --- |
| `/websites/{id}/search/properties` | `{}` | Matching `properties` with `siteUrl` and `permissionLevel` |
| `/websites/{id}/search/dashboard` | `site_url`, `start_date`, `end_date` | `summary`, `daily`, `queries`, `pages` containing original Google rows |
| `/websites/{id}/search/inspect` | `site_url`, `url` | Original URL Inspection response |

Reports accept real, ordered dates with at most 366 inclusive days. URLs must be
HTTP(S), on the selected hostname and within the chosen property, without userinfo,
a custom port, or a fragment. HTP's bearer token is required. Only live URL
Inspection requires `X-Google-Access-Token`; properties and dashboards read saved
snapshots and return HTTP 202 while awaiting the first sync. Browser calls use equivalent
`/api/websites/{id}/search/...` routes; Google tokens remain on the server.
Unauthorized access, missing scopes, rejected requests, quota failures, and
upstream outages produce explicit sanitized errors.

Official contracts: [Search Analytics](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
and [URL Inspection](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect).

## GitHub repository history

Owners can attach a public GitHub repository to each website, collect commit history
in the background, and review it alongside performance reports. See
[configuration, REST, and MCP usage](docs/github-history.md).

### AI agent access to SEO data

The authenticated MCP endpoint exposes `list_websites`, `website_saved_data`
(sources, complete snapshots and profile changes), and `website_repository_history`.
See [agent access and pagination](docs/mcp-seo.md) for connection details, all saved
report kinds, freshness interpretation and verification commands.

The secured MCP endpoint also supports browser OAuth sign-in. Add its URL in an
agent's remote MCP settings, sign in to HTP when the browser opens, and approve
access. Supabase handles PKCE and refresh tokens; manage grants under Connections
→ Authorized apps. See [browser authentication](docs/mcp-seo.md#browser-sign-in-recommended).

## Bing Webmaster Tools

Connect Bing under **Connections** for read-only search traffic, dated query/page
statistics, crawl health, and sitemap reports in the website overview. The
independent daily collector retains observations, supports saved-data access
through MCP (`bing_sources` / `bing_snapshots`), and keeps reports readable after
disconnection. Bing's reporting periods differ from Google's: only Bing's daily
traffic rows use the overview date filter.

See [Bing reporting setup](docs/bing-sync.md) for the migration, OAuth client,
encrypted grant configuration, Edge Function and Vault/Cron rollout. The new
feature requires that configuration before live reporting is available.

## Seosmith technical SEO audits

HTP accepts website-scoped Seosmith pushes and owner-authenticated JSON imports.
The Overview → Technical SEO section retains every run, plots history by scan
time, and provides searchable findings and checked URLs. Complete runs with
matching settings support finding-change comparisons.
See [Seosmith ingestion and history](docs/seosmith.md) for API, access controls,
migrations, worker provisioning and verification.

## Priority-page performance investigation

Site health can sample priority URLs using the existing daily PageSpeed and CrUX collectors, with explicit URL/origin scope, lab/field evidence, and device-specific history. The sample UI is disabled until the coordinated rollout is complete. See [contracts, bounds and rollout](docs/page-performance.md).
