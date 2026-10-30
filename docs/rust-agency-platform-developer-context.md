# Rust Agency Website Management Platform

Developer context and proposed architecture · 2026-10-28 · Version 1.0

## 1. Purpose and provenance

Build a multi-tenant platform through which an agency manages custom client websites, clients view performance and request changes, and staff coordinate implementation and delivery. Most managed websites live in GitHub repositories and deploy through Cloudflare.

This document is implementation context for human and AI developers. It is a proposed specification, not a description of an existing codebase. The referenced conversation, **Research Google APIs**, confirms these requirements:

- Automate management of client websites and provide self-service access.
- Clients primarily view analytics and request changes.
- Staff use the same system for more detailed work.
- Managed websites are primarily custom-built and deployed through GitHub/Cloudflare.
- Use a Rust backend; this request additionally specifies a Nuxt frontend.

The retrieved conversation exposed its user messages, but earlier assistant responses were unresolved content references. Architectural choices below are explicit recommendations made for this document; they should not be mistaken for recovered prior agreements. No application, integration connection, or cloud resource has been created by preparing this document.

**Implementation convention:** Treat MUST as a release requirement, SHOULD as the default with documented exceptions, and LATER as outside the first release. Provider capabilities and dependency APIs must be checked again when implementation begins. Linked sources were consulted on 2026-10-28; dependency combinations have not been compiled or tested here.

## 2. Product vision and scope

Give every client a clear answer to three questions: “How is my website performing?”, “What work is underway?”, and “What changed?” Give agency staff one place to coordinate requests, repositories, previews, releases, and integration health.

The platform is a management layer over existing repositories and hosting. It does not require client websites to adopt a common CMS or frontend framework. Nuxt is the management portal frontend; managed websites may use other stacks.

### First-release outcomes

1. Clients sign in, choose an authorized site, see understandable GA4 and Search Console reports, and submit requests with attachments.
2. Staff triage requests, assign work, link GitHub issues and pull requests, share previews, and record approvals.
3. Staff see Cloudflare deployment state and verify which commit reached production.
4. Administrators manage clients, permissions, site mappings, provider connections, and failed background work.
5. Every sensitive action is authorized, tenant-scoped, recoverable where practical, and auditable.

### Boundaries

The MVP excludes a visual page builder, automatic AI code deployment, billing, domain registration, bulk DNS changes, comprehensive SEO crawling, and hosting arbitrary client code inside the portal. AI summaries and code assistance may be added later, subject to human review. Reporting does not itself install GA4 tracking or guarantee that website consent settings permit collection.

## 3. Tenancy, roles, and permissions

**Chosen model:** An agency is the top-level tenant. Each agency owns client accounts, sites, staff memberships, and integrations. Client users receive access through an agency membership plus an explicit client-account membership. Staff receive either an all-clients grant or individual client assignments. A user may belong to multiple agencies without sharing any agency data.

Use the names `agency_id`, `client_id`, and `site_id` consistently. A client account is an authorization boundary inside an agency, not a synonym for the top-level tenant.

| Role | Scope and capabilities |
|---|---|
| Agency owner | Agency administration, admin membership, connections, policy settings, all client work |
| Agency administrator | Client/site onboarding, staff assignments, operational settings, integrations; cannot remove the last owner |
| Staff manager | Assigned or all-client work, triage, assignment, QA, authorized release approvals |
| Staff developer | Assigned sites, requests, technical details, issue/PR links, previews; production actions require an explicit release capability |
| Client administrator | Own client accounts/sites, reports, requests, public comments, client approval, invitations within permitted client scope |
| Client member | Own permitted sites, reports, requests, public comments; approval only if separately granted |
| Platform operator | Infrastructure operations; no default right to browse agency content; audited, time-limited support access if introduced |

Roles map to capabilities such as `request.assign`, `request.comment_internal`, `integration.manage`, `release.approve`, and `client.invite`. Backend policy checks are authoritative. UI visibility alone is never authorization. Invitations cannot grant broader authority than the inviter holds. Removing membership or a site assignment must revoke access on subsequent requests, including attachment downloads and background-job inspection.

## 4. Client and staff experience

### Client portal

- Overview: available sites, traffic/search trends, open requests, latest successful production release.
- Analytics: date range, previous-period comparison, source-specific freshness, top pages, acquisition channels, search queries, devices, and clear metric definitions.
- Requests: title, description, affected URL, desired result, optional desired date, attachments, public discussion, status, preview, and approval history.
- Activity: client-visible progress and releases. Internal notes, credentials, operational errors, and unrestricted build logs remain staff-only.
- Connection notices distinguish “not connected”, “permission required”, “sync delayed”, “no activity”, and “provider unavailable”.

### Staff workspace

- Work queue across authorized clients, filtered by assignee, priority, status, deadline, and site.
- Request detail with separate public discussion and internal notes; internal content is excluded from client API responses and notifications.
- Site operations view with repository, production branch, deployment adapter, latest production SHA, previews, and integration diagnostics.
- Connection onboarding, manual sync controls, failed-job retries, audit records, and assignment management according to role.
- Technical links must be access-controlled; a linked private GitHub resource does not become readable merely because its URL is stored.

### Request lifecycle

```text
submitted -> triaged -> planned -> in_progress -> internal_review
          -> client_review -> approved -> deploying -> completed

triaged/planned/in_progress/review -> blocked -> previous valid work state
client_review -> in_progress when changes are requested
any eligible unfinished state -> cancelled by an authorized actor
deploying -> blocked when release fails; completion requires verification
```

Implement an explicit transition table with actor permissions, prerequisites, and event names. Do not allow arbitrary status updates. Store a monotonically increasing version for optimistic concurrency.

Staff clarify scope before work starts. A developer works in a branch and PR under repository rules. Staff QA identifies a preview URL and immutable commit SHA. Client approval references that revision and preview. Any code change invalidates that approval. Approval authorizes the requested content; a separate authorized staff action or protected CI environment controls production release. PR merge alone does not prove successful deployment.

Completion requires a matching successful production deployment, a recorded verification result, and a client-visible completion note. For the MVP, staff may perform GitHub writes and merges in GitHub and link them into the portal. Automated issue creation is an optional, explicitly configured agency automation; portal-driven merge is deferred.

## 5. Architecture and runtime decision

Start with a modular Rust monolith and two runnable processes: HTTP API and background worker. Share domain services and provider adapters in one Cargo workspace. Use PostgreSQL as the system of record and durable job store, plus private object storage for attachments. Redis is optional later; it is not needed for the initial job queue.

```mermaid
flowchart LR
    U[Clients and agency staff] --> N[Nuxt portal]
    N --> E[Same-origin API routing]
    E --> A[Axum API on native Rust runtime]
    A --> P[(PostgreSQL)]
    A --> O[Private attachment storage]
    P --> W[Tokio background worker]
    W --> G[GitHub APIs]
    W --> C[Cloudflare APIs]
    W --> GA[GA4 Data API]
    W --> SC[Search Console API]
    G --> H[Verified webhook ingress]
    H --> P
```

**Hosting decision:** Run the API and worker as native Linux Rust services in a container-capable environment with persistent PostgreSQL access. Cloudflare may provide DNS, proxying, portal hosting, client-site hosting, and R2 storage. Choosing the service host remains an implementation decision; this document does not select or provision one.

Cloudflare Workers Rust executes through its WebAssembly-oriented tooling. Do not assume a conventional Tokio networking runtime and native SQLx PostgreSQL pool can be moved there unchanged. A Workers-only backend requires a separate adapter/runtime design and proof of compatibility. See [Cloudflare Rust support](https://developers.cloudflare.com/workers/languages/rust/).

The Nuxt portal SHOULD use one public origin with `/api` routed to Axum. Deploy as a static client application initially, or select and test an appropriate Nuxt/Nitro Cloudflare preset if SSR is required. SSR must never cache personalized HTML globally. Cloudflare documents a [Nuxt deployment path](https://developers.cloudflare.com/pages/framework-guides/deploy-a-nuxt-site/).

### Module and repository layout

```text
apps/portal/                    Nuxt, Vue, TypeScript
crates/api/                     Axum routes, extractors, middleware, OpenAPI
crates/domain/                  IDs, policies, state transitions, domain errors
crates/application/             use cases and transaction orchestration
crates/persistence/             SQLx queries, tenant transactions, job store
crates/integrations/            Google, GitHub, Cloudflare adapters
crates/worker/                  job executor, scheduler, reconciliation
migrations/                    PostgreSQL schema and RLS policies
tests/                         integration, isolation, contract fixtures
docs/                          architecture decisions, runbooks, API contracts
```

Keep handlers thin. Application services enforce policies and workflows. Domain code should not depend on Axum or provider response models. Provider adapters normalize external responses into internal types. Do not introduce a network service per provider in the MVP.

## 6. Rust stack and SDK caveats

Resolve compatible versions during implementation, commit `Cargo.lock`, and pin a tested Rust toolchain. Use edition 2024; choose an MSRV supported by the actual resolved dependencies rather than assuming edition support alone is sufficient. This is a dependency selection guide, not a copy-ready compiled manifest.

| Need | Crates or approach | Notes |
|---|---|---|
| HTTP API | `axum`, `tower`, `tower-http` | Typed extractors, middleware, tracing, request limits; [Axum docs](https://docs.rs/axum/latest/axum/) |
| Async execution | `tokio`, `tokio-util` | Bounded concurrency, timeouts, cancellation, shutdown; [Tokio docs](https://docs.rs/tokio/latest/tokio/) |
| PostgreSQL | `sqlx` | Explicit SQL, migrations, transactions, PostgreSQL/Tokio/TLS features; [SQLx docs](https://docs.rs/sqlx/latest/sqlx/) |
| HTTP integrations | `reqwest`, `serde`, `serde_json`, `url` | Reused async clients, typed DTOs, bounded responses; [reqwest docs](https://docs.rs/reqwest/latest/reqwest/) |
| OAuth delegation | `oauth2` | Authorization-code flow and PKCE; application still owns secure token storage and authorization; [docs](https://docs.rs/oauth2/latest/oauth2/) |
| Login federation | `openidconnect` | Verify OIDC identity; OAuth delegation by itself is not authentication; [docs](https://docs.rs/openidconnect/latest/openidconnect/) |
| Sessions | `tower-sessions` and compatible persistent store | Verify middleware/store/SQLx compatibility together; [session docs](https://docs.rs/tower-sessions/latest/tower_sessions/) |
| GitHub | `octocrab`, or narrow `reqwest` adapter | Third-party Rust client, not GitHub's official Octokit SDK; [Octocrab docs](https://docs.rs/octocrab/latest/octocrab/) |
| Google generated clients | `google-analyticsdata1_beta`, `google-searchconsole1`, optional `yup-oauth2` | Alternative to hand-written REST adapters; review transport and token-cache behavior |
| Cloudflare management | Narrow REST adapter; evaluate `cloudflare` crate | Check actual endpoint coverage and compatibility; [crate docs](https://docs.rs/cloudflare/latest/cloudflare/) |
| Errors and telemetry | `thiserror`, `anyhow`, `tracing`, `tracing-subscriber` | Typed domain errors; contextual operational errors with redacted secrets |
| IDs/time/API contracts | `uuid`, `time` or `chrono`, `utoipa` | Choose one main time library; generate and review OpenAPI |
| Webhook verification | `hmac`, `sha2`, constant-time verification API | Authenticate raw request bytes before parsing |
| Tests and security | `wiremock` or equivalent, `proptest`, `cargo-audit`, `cargo-deny` | Select compatible versions; test real PostgreSQL behavior |

### Provider client rules

- Default recommendation: small typed REST adapters for GA4, Search Console, and missing Cloudflare endpoints. Use Octocrab where its implemented GitHub operations fit. Hide each choice behind an application-owned interface.
- Google has official Rust Cloud client libraries, but support must be checked per service. Availability of Google Cloud Rust libraries does not imply official GA4 Data API or Search Console Rust coverage. Consult [Google's Rust service catalog](https://docs.cloud.google.com/rust/docs/reference).
- The generated [Analytics Data crate](https://docs.rs/google-analyticsdata1_beta) and [Search Console crate](https://docs.rs/google-searchconsole1) belong to the community Google APIs Rust ecosystem. Their schema-derived names and API surface do not establish official vendor support or current endpoint availability. Inspect repository provenance, release history, generated schema revision, and API deprecations.
- Generated clients can pull in different Hyper, Rustls, OAuth, and HTTP-client generations. Do not mix sample code from different major versions. Keep authentication and token persistence under application control; a process-global or local-file token cache is unsuitable for multi-tenant credentials.
- The Cloudflare management API client and the Workers Rust runtime SDK solve different problems. Installing either does not make native Axum/SQLx deployment work inside Workers.
- Do not assume the newest version of every crate composes cleanly. In particular, validate OAuth client transport traits, SQLx feature names, session-store versions, and TLS roots. Use raw HTTP only behind a tested adapter when an SDK lacks an endpoint.
- Reuse connection-pooled clients with explicit connect and overall timeouts. Disable redirects for token exchanges; restrict provider destinations. Distinguish authentication, authorization, quota, validation, timeout, and transient-provider failures.

## 7. GitHub App integration

Use a GitHub App installed only on selected repositories. Store stable installation and repository IDs along with display names. An installation may cover multiple client sites, so an installation ID alone is never a tenant authorization decision.

Initial app permissions SHOULD be metadata and read access needed for issues, pull requests, checks, and deployments. Request writes only when enabling a specific automation. Do not request repository administration, workflow modification, or broad content writes by default.

Use an app JWT to request a narrowly scoped installation token for app-owned background automation. Respect returned expiry and treat tokens as opaque strings without fixed-length assumptions. Encrypt the app private key in a secret manager; cache installation tokens briefly on the server. See [installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

For actions performed on behalf of a GitHub user, use a GitHub App user access token and enforce that user's permissions. Portal role membership must not be used to circumvent GitHub permissions through a privileged installation token. Define agency automation separately from user-delegated operations. Follow [GitHub App security guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).

Consume installation/repository-access, issues, pull request, check/workflow, and deployment events as needed by the chosen workflow. Verify `X-Hub-Signature-256` using the raw body and constant-time HMAC verification. Deduplicate on provider/app/delivery ID. Validate installation-to-repository mapping, persist a durable inbox event, and return success only after durable acceptance. See [webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

Webhook payloads are events, not authoritative instructions. Reconcile important state from the API, tolerate unknown event fields, and handle duplicates and out-of-order delivery. Installation suspension/uninstallation or repository removal marks mappings unavailable and stops new work until reauthorized. Periodic reconciliation covers missed events.

## 8. Cloudflare integration and deployment safety

Model each site as `cloudflare_pages`, `cloudflare_workers`, or `external` hosting, with separate adapters. Store the exact account/project or Worker identity and production environment. A Cloudflare account may hold many clients; every action must match the stored site mapping.

Use least-privilege API tokens scoped to needed accounts/resources. Store credential references server-side. Validate access during onboarding and distinguish read-only status access from deployment or cache-purge authority. Provider permissions may be broader than a single project; application allowlists must narrow operations further. The [Pages API guide](https://developers.cloudflare.com/pages/configuration/api/) describes token-based API access.

Prefer the site's existing GitHub-to-Cloudflare pipeline. The portal tracks work and release evidence; it does not become a build runner. Configure exactly one production deployment owner per site: native Git integration or protected CI deployment. Avoid running both for the same release. CI-based Direct Upload is another documented [Pages deployment option](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

Store deployment ID, source SHA, branch, environment, status, URL, provider timestamps, and verification outcome. A preview build, successful CI check, merge, and successful production deployment are distinct facts. When the provider cannot supply a trustworthy SHA, record the missing evidence and require explicit verification rather than claiming a match.

MVP uses polling/reconciliation for Cloudflare state; do not assume a universal Cloudflare deployment webhook. Later mutations such as purge, redeploy, or rollback require explicit capability checks, an audited action, bounded resource identifiers, and provider-specific support. Never invent a generic rollback endpoint or promise rollback of external database changes. Record a new release attempt for retries and rollbacks.

## 9. Google analytics and search integrations

### Connection onboarding

Use delegated Google OAuth for background read access. The initiating staff/admin user must already have authority to connect the agency/client scope. After consent, discover or validate accessible resources and require an explicit site-to-property selection. Do not infer a GA4 property from a hostname or measurement ID, or assume a Search Console URL-prefix property and domain property are interchangeable.

Recommended read scopes are `https://www.googleapis.com/auth/analytics.readonly` and `https://www.googleapis.com/auth/webmasters.readonly`. Request only the enabled integration's scopes. Record granted scopes, granting subject, ownership scope, property identity, and connection health. Search Console requires appropriate property access; possessing an OAuth token is insufficient. See [Search Console authorization](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing).

Service-account access is an optional later path when the customer explicitly grants that principal access to the relevant resources; it is not an automatic substitute for client consent. Domain-wide delegation is outside MVP scope.

### GA4

Use the Analytics Data API for reporting and the Admin API only as needed for property discovery/metadata. `properties/{property_id}:runReport` retrieves reports; do not use the legacy Universal Analytics Reporting API. Suggested reports include daily sessions/views, active users, engagement, configured key events, top pages, and channel breakdowns. Validate metric/dimension compatibility and retain response metadata. See [GA4 runReport](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport).

Store GA4 property timezone and currency. Display key-event metrics only when configured and available. Report dates use the property timezone. Do not invent revenue or conversions from arbitrary event names. Record provider processing lag, thresholding, sampling, and data-quality metadata when supplied.

Quota scheduling must account for property and project limits; request quota information where supported. Bound report shapes and backfills, cache results, and avoid a provider request for every dashboard render. Numerical quotas belong in configuration after checking the [current Data API quota documentation](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas).

### Search Console

Use `sites.list` for accessible properties and `searchanalytics.query` for clicks, impressions, CTR, position, and selected dimensions. Preserve exact property identifiers such as `sc-domain:example.com` or a URL-prefix identifier. Query dates use Pacific Time as documented by the API, independently of the agency timezone. See [Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).

Paginate with `startRow`/`rowLimit`, but label page/query tables as returned top rows: the API does not guarantee every underlying row. Do not represent paginated results as a complete raw search dataset. Separate preliminary/recent observations from finalized reporting where supported. Budget per-site, per-user, and project load under the [Search Console usage limits](https://developers.google.com/webmaster-tools/limits).

### Reporting correctness requirements

- Store reports by source, property, date window, report definition version, dimensions, filters, and data state. Never mix different definitions in a chart.
- Source-wide totals must be fetched as source-wide totals. Summing daily active users overcounts period users; summing users across page/channel rows also double-counts people. A requested 28-day user count needs a 28-day report, not the sum of 28 daily counts.
- Compute aggregate CTR as total clicks divided by total impressions. Compute an aggregate position only over a compatible complete report grain using impression weighting; otherwise request the provider aggregate. Never average row-level CTR or position without weighting and completeness checks.
- GA4 sessions and Search Console clicks describe different activity. Present them in separate series with definitions; differences are expected. Do not imply reconciled totals.
- Compare equal-length periods in the source timezone and label the last available date. For zero denominators, display an unavailable percentage change rather than infinity. Zero activity, missing data, and failed syncs must have distinct representations.
- Shared GA4 properties require a validated site filter. If reliable site-level isolation cannot be demonstrated for every supported report, require a dedicated property. A connection granting access to many properties does not authorize exposing all of them to a client.
- Portal reports expose cached authorized data only. Show `last_successful_sync_at`, covered date range, freshness, and completeness. A provider outage must not replace historical observations with zeros.

## 10. Nuxt frontend design

Use a supported stable Nuxt release with Vue and TypeScript, pinned through a package-manager lockfile. Generate TypeScript API types from backend OpenAPI; do not manually maintain divergent request models.

Suggested routes:

```text
/login
/a/:agencyId/overview
/a/:agencyId/clients/:clientId/sites/:siteId/analytics
/a/:agencyId/clients/:clientId/requests
/a/:agencyId/clients/:clientId/requests/:requestId
/a/:agencyId/work
/a/:agencyId/sites/:siteId/operations
/a/:agencyId/settings/members
/a/:agencyId/settings/integrations
```

Use server-issued session cookies with credentialed same-origin API requests. Never put provider access tokens, refresh tokens, session secrets, or Cloudflare credentials into localStorage, public runtime configuration, hydration payloads, or generated assets.

Provide keyboard-accessible forms, responsive tables, chart text alternatives, clear empty/error/loading states, and confirmation of consequential release actions. Public and internal comments need visibly distinct composition modes. Encode untrusted content; sanitize rendered Markdown. Route guards improve navigation, while Axum policies enforce access.

Invalidate scoped caches and cancel old requests when users switch agency/client/site. Query keys include scope and report definition. If SSR is added, prevent user/session data from leaking through shared module state or caching. Session expiration should return the user to sign-in without displaying another account's cached results.

## 11. Logical PostgreSQL schema

UUID primary keys, `timestamptz` for instants, `date` for source-local reporting dates, and explicit source timezone fields are the default. Use `bigint` for provider counters, `numeric` for precision-sensitive values, and text for opaque provider IDs. The following is a logical model to translate into reviewed migrations, not executable DDL.

| Table | Essential fields and constraints |
|---|---|
| `users` | `id`, display profile, status, timestamps; no provider token columns |
| `user_identities` | `user_id`, `issuer`, `subject`; unique `(issuer, subject)`; verified email is profile data, not the identity key |
| `agencies` | `id`, name, slug, display timezone, status |
| `agency_memberships` | `agency_id`, `user_id`, role, all-client grant, status; unique agency/user |
| `clients` | `id`, `agency_id`, name, status |
| `client_memberships` | `agency_id`, `client_id`, `user_id`, role, status; requires matching active agency membership |
| `staff_assignments` | `agency_id`, `client_id`, `user_id`, capability overrides; requires staff membership |
| `sites` | `id`, `agency_id`, `client_id`, canonical origin, hostname, hosting kind, status |
| `site_access_grants` | `agency_id`, `client_id`, `site_id`, `user_id`, capabilities; optional narrower client-user scope |
| `invitations` | agency/client scope, invited email, permitted role, token hash, inviter, expiry, consumed timestamp |
| `sessions` | opaque ID/hash per chosen library, `user_id`, expiry, authentication context; active scope is not authority |
| `provider_connections` | `id`, `agency_id`, optional `client_id`, provider, external subject/account, encrypted credential reference, granted scopes, health, token expiry, version |
| `github_installations` | `agency_id`, connection, installation ID, account ID, state; explicit grants if intentionally shared |
| `site_repositories` | `agency_id`, `site_id`, installation reference, stable repository ID, owner/name, branch; default one primary repo |
| `site_hosting_targets` | agency/site/connection, account ID, project or Worker ID, environment, deployment mode; unique primary production target |
| `site_analytics_bindings` | agency/site/connection, provider, exact property ID, validated filter definition, timezone, currency, active interval |
| `change_requests` | agency/client/site, requester, assignee, title, body, priority, status, version, desired date, timestamps |
| `request_comments` | agency/request, author, visibility `client` or `internal`, body, timestamps; internal visibility changes require explicit policy |
| `attachments` | agency/client/request, uploader, random storage key, filename, MIME, size, checksum, scan status |
| `request_external_links` | agency/request/repository, kind, external issue/PR ID, canonical URL, latest observed state |
| `request_approvals` | agency/request, actor, approval kind, exact commit SHA, preview/deployment reference, decision, invalidated timestamp |
| `deployments` | agency/site/target, provider ID, environment, commit SHA, status, URL, provider timestamps, last reconciled time, verification result |
| `analytics_reports` | agency/site/binding, source, definition version, date window, filter/dimension hash, generation, status, completeness, metadata, fetched time |
| `analytics_report_rows` | agency/report, row index, source-local date if applicable, dimension values, typed metric values; unique report/row |
| `sync_cursors` | agency/binding/report-kind, cursor/date watermark, last success, next scheduled time, last error classification |
| `jobs` | agency, optional client/site, type, versioned payload, dedupe key, status, attempts, run time, lease owner/expiry, fencing version, last error |
| `outbox_events` | agency, event ID/type, aggregate/version, payload, publication state, attempts |
| `webhook_inbox` | provider/app/delivery ID, verified receipt time, installation/repository identifiers, bounded payload or reference, processing status |
| `notifications` | agency/user/request, channel, public-safe payload, dedupe key, delivery state |
| `audit_events` | agency/client/site, actor, action, resource, redacted before/after or event data, timestamp, trace ID |

### Isolation and integrity

Every tenant-owned row MUST carry `agency_id`. Client-owned resources also carry or derive an unambiguous `client_id`. Use composite foreign keys, for example `(agency_id, client_id)` to `clients(agency_id, id)` and `(agency_id, client_id, site_id)` to `sites(agency_id, client_id, id)`. Add the required matching unique constraints. A UUID by itself does not prevent cross-tenant links.

Repositories require a `TenantContext` containing an authenticated principal and verified membership/client scope. Queries must include agency and applicable client/site authorization. RLS is defense in depth: set transaction-local context after authorization, use a non-owner application role with no `BYPASSRLS`, force policies where appropriate, and test policies on every tenant table. Missing context must deny access. Do not leak scope across pooled connections or hold SQL transactions open during provider HTTP calls.

Agency-only RLS does not protect one client from another inside that agency. Enforce client/site grants in queries and policies or narrowly exposed database functions. Privileged system jobs and webhook dispatch use a separately restricted execution path with explicit mapping resolution; never expose a generic bypass endpoint.

Add indexes for memberships, site lists, request queue filters, report windows, provider resource lookups, active job claims, and delivery deduplication. Analytics report replacement is staged into a new generation and atomically published after all required pages finish. Failed pagination must not publish a seemingly complete result.

Credentials MUST remain outside generic JSON payloads. Apply documented retention to provider data, attachments, webhook bodies, audit records, and backups. Soft-deleted sites stop synchronization immediately. Purge/revocation workflows must account for external-resource references and retained backups; final retention values require an agency policy decision.

## 12. Authentication, OAuth, and security

### Separate login from provider connections

Use a vetted OIDC identity provider for portal sign-in, with invitation-controlled membership. Verify issuer, audience, signature, expiry, nonce, and authorization-code state. Bind accounts by issuer/subject; never silently link identities by an unverified matching email. Require MFA for privileged staff through the identity provider.

Provider connection consent is a separate workflow. Use authorization code plus PKCE where supported, exact redirect URIs, high-entropy one-use state, and a short expiry. Bind state to the signed-in initiating user, agency, intended client, provider, and intended action. Recheck the user's authority at callback time. Reject replay, wrong-scope callbacks, and arbitrary return URLs.

For Google background access, request offline access and handle absent refresh tokens without overwriting an existing valid token with null. Reauthorization may be needed depending on prior consent and provider behavior. Production rollout must review consent-screen publishing, requested scope verification requirements, privacy disclosures, and testing-mode restrictions. Follow [Google web-server OAuth guidance](https://developers.google.com/identity/protocols/oauth2/web-server).

Encrypt refresh tokens, API tokens, and private keys using authenticated encryption backed by a managed key/secret system. Include agency/connection identity in associated data, record key versions, and support rotation. Serialize token refresh per connection across worker instances using a lease/version mechanism; preserve newly rotated credentials atomically. On revocation or `invalid_grant`, stop affected jobs and mark `reauthorization_required`.

### Application controls

- Store opaque sessions server-side; use Secure, HttpOnly cookies, appropriate SameSite settings, bounded idle/absolute lifetimes, and rotation at authentication changes. Persist sessions across API replicas and revoke them on logout.
- Require CSRF protection and Origin checks for state-changing cookie-authenticated routes. Keep GET read-only. OAuth callbacks and verified webhook routes use their own narrowly defined defenses.
- Prefer same-origin routing. If cross-origin deployment is necessary, allow only exact trusted origins and credentialed requests; never use wildcard credentialed CORS.
- Check object-level access for list/detail/export/download/update paths. Resource IDs supplied in bodies are untrusted and cannot override authenticated scope.
- Upload only to randomized private keys using short-lived, narrowly scoped grants. Enforce size/type limits, quarantine and scan, and serve safe download headers. No public bucket or arbitrary HTML execution.
- Protect affected-page URLs, screenshots, health checks, and URL fetchers against SSRF: block private/link-local destinations, validate resolved addresses and redirects, and allow only approved schemes/targets. Client-supplied URLs must not become provider base URLs or shell commands.
- Keep client-generated text, repository content, webhook fields, and AI suggestions as untrusted input. Never execute them as operational instructions.
- Use secret redaction in logs, error responses, tracing, and fixtures. Audit permission, connection, approval, release, support-access, and credential-lifecycle actions without storing secrets.
- Rate-limit login, invitations, mutations, upload grants, webhooks, and manual synchronization. Bound request bodies, response bodies, query windows, and list pagination.
- Development, staging, and production use distinct credentials and databases. Production data must not be copied into ordinary local fixtures.

## 13. Jobs, synchronization, and recovery

Use PostgreSQL-backed durable jobs with at-least-once execution. A Tokio task is an execution unit, not a durable queue. Insert work in the same transaction as the originating state change, or use an outbox event in that transaction.

| Job | Trigger and initial proposed schedule |
|---|---|
| GA4 refresh | On connection, then daily with jitter; revisit the recent seven days for processing changes |
| Search Console refresh | On connection, then daily with jitter; revisit the recent ten days and mark data state |
| Initial backfill | Bounded chunks, default last 90 days subject to available data and quota |
| Deployment reconciliation | Active releases approximately every minute, then back off; inactive sites less frequently |
| GitHub reconciliation | Webhook-driven plus periodic checks for missed or stale state |
| Credential refresh/health | Before token expiry or on demand under a per-connection lock |
| Attachment processing | On upload completion, then bounded scan/cleanup retries |
| Notification delivery | From domain outbox, with dedupe and per-recipient access checks |
| Maintenance | Expired sessions/invites/leases, retention cleanup, backup verification |

These intervals are product defaults, not provider freshness guarantees. Store configuration per integration, spread work across agencies, and enforce fair scheduling so one large backfill cannot starve other clients.

Workers claim due jobs in short transactions using a safe row-locking strategy such as `FOR UPDATE SKIP LOCKED`. Store a lease owner, expiry, heartbeat, and fencing/version token; expired workers cannot commit results over a newer attempt. Use bounded provider/account/property concurrency, request timeouts, and cancellation-aware shutdown. Expired leases return to the queue.

Retry transient transport/provider failures and quota responses with exponential backoff, jitter, and `Retry-After` where available. Refresh expired authentication once when appropriate. Permission removal, invalid inputs, and revoked credentials require a permanent failure or user action rather than unlimited retries. Cap attempts and expose a dead-letter queue with safe administrator retry.

Idempotency keys include scope, operation, resource, and relevant version/window. Provider writes may succeed before a timeout; inspect remote state or use provider idempotency facilities before retrying. Never claim exactly-once delivery. A job payload contains identifiers, not credentials, and the worker revalidates mappings and current permission/automation grants before acting.

Poll reconciliation is mandatory even with webhooks. Record last attempt separately from last successful sync. Backfill cursors and report publication advance only after successful persistence. Emit metrics for queue age, retries, lease recovery, provider latency, quota exhaustion, and stale-site coverage.

## 14. API contract

Version routes under `/api/v1`. JSON request/response types are derived from a reviewed OpenAPI contract. Path agency/client/site scope must match authorization; path ownership is not established by the path itself.

| Method and route | Purpose / authorization |
|---|---|
| `GET /auth/login`, `GET /auth/callback` | OIDC flow with one-use state; exact callback configuration |
| `POST /auth/logout` | Revoke current session; CSRF protected |
| `GET /api/v1/me` | Current identity, permitted memberships and capabilities |
| `GET /api/v1/agencies/{agency}/clients` | Authorized client list |
| `GET /api/v1/agencies/{agency}/sites` | Authorized site list; optional authorized client filter |
| `GET /api/v1/agencies/{agency}/sites/{site}` | Site detail with role-filtered fields |
| `GET /api/v1/agencies/{agency}/sites/{site}/analytics` | Cached reports; validated source, report kind, date window |
| `POST /api/v1/agencies/{agency}/sites/{site}/syncs` | Staff queues a bounded sync; returns job ID |
| `GET, POST /api/v1/agencies/{agency}/clients/{client}/requests` | List/create requests within allowed scope |
| `GET, PATCH /api/v1/agencies/{agency}/requests/{request}` | Read/update allowed fields; expected version required for mutation |
| `POST /api/v1/agencies/{agency}/requests/{request}/transitions` | Validated workflow command and expected version |
| `POST /api/v1/agencies/{agency}/requests/{request}/comments` | Public or explicitly authorized internal comment |
| `POST /api/v1/agencies/{agency}/requests/{request}/approvals` | Revision-bound decision and expected request version |
| `POST /api/v1/agencies/{agency}/requests/{request}/attachments` | Authorized upload grant; completion endpoint verifies stored object |
| `GET /api/v1/agencies/{agency}/attachments/{attachment}/download` | Recheck visibility; return short-lived download grant |
| `GET /api/v1/agencies/{agency}/sites/{site}/deployments` | Normalized deployment evidence |
| `POST /api/v1/agencies/{agency}/connections/{provider}/authorize` | Authorized integration initiation; returns provider consent URL |
| `GET /integrations/{provider}/callback` | Bind verified one-use OAuth state to stored connection |
| `POST /api/v1/agencies/{agency}/sites/{site}/bindings` | Admin validates and sets provider resource mapping |
| `DELETE /api/v1/agencies/{agency}/connections/{connection}` | Disable jobs, revoke where supported, remove stored credentials |
| `POST /webhooks/github` | Signature-authenticated durable event acceptance, no browser session |
| `GET /api/v1/agencies/{agency}/jobs/{job}` | Authorized sanitized job status |
| `POST /api/v1/agencies/{agency}/jobs/{job}/retry` | Authorized retry of eligible failed work |
| `GET /api/v1/agencies/{agency}/audit-events` | Staff/admin scope only |
| `GET /health/live`, `GET /health/ready` | Minimal health output; readiness checks critical dependencies |

Membership, invitations, assignments, and settings receive scoped admin endpoints using the same policy service. Do not expose arbitrary provider proxy endpoints, SQL execution, repository commands, or a generic “run job” endpoint.

Use cursor pagination, bounded limits, ISO 8601 timestamps, explicit source-local date fields, and stable error codes. Return `202 Accepted` with an authorized job URL for asynchronous work. Use `409 Conflict` for stale request versions and invalid concurrent transitions; return an appropriate generic `404` for inaccessible resources when necessary to prevent enumeration.

Mutation retries use an `Idempotency-Key` bound to agency, actor, route, and request-body hash, with a documented retention window. A reused key with a different body is a conflict. Database transactions atomically write state, audit events, and outbox work.

Example error contract:

```json
{
  "error": {
    "code": "INTEGRATION_REAUTH_REQUIRED",
    "message": "This connection needs to be authorized again.",
    "request_id": "opaque-trace-id",
    "retryable": false
  }
}
```

Analytics responses include `source`, `property_timezone`, `report_definition_version`, `date_range`, `data_through`, `last_successful_sync_at`, `freshness`, `completeness`, and relevant provider warnings alongside metric data. Never return credential material or raw provider exceptions.

## 15. Operations and release engineering

- Run schema migrations once per deployment with a dedicated migrator identity. Use backward-compatible expand/contract changes for rolling API/worker releases.
- API and worker share a versioned job payload contract. Older deployed workers must safely reject or defer unknown versions.
- Observe request latency/error rate, database pool pressure, queue age, provider health, report freshness, and production verification failures. Alerts route to staff; clients receive concise actionable notices.
- Keep structured logs tied to request/job/event IDs and scope IDs, subject to retention and redaction. Do not log analytics query text or personal data unnecessarily.
- Back up PostgreSQL and attachment storage; define target RPO/RTO before pilot and prove restoration in a separate environment. Document token/key rotation, provider outage, webhook replay, queue recovery, and tenant offboarding.
- CI checks formatting, linting, unit/integration tests, API contract changes, frontend type checks/build, migrations on an empty and upgraded database, and dependency advisories. Use read-only or fixture-based provider tests by default.
- Repository CI remains the build execution boundary for client sites. Do not run untrusted repository build scripts in the management API or on a worker holding agency-wide secrets.

## 16. MVP delivery roadmap

Phases are ordered by dependencies and exit evidence, not promised calendar estimates.

| Phase | Scope | Exit evidence |
|---|---|---|
| 0 — Feasibility | Resolve dependency set; test native runtime; validate one real GA4 property, Search Console property, GitHub App installation, and Cloudflare site | Narrow integration spike proves authentication, required reads, deployment identity, and Nuxt-to-API session flow; ADRs record gaps |
| 1 — Foundation | OIDC, invitations, agencies/clients/sites, assignments, SQLx migrations, authorization/RLS, audit, durable jobs | Two agencies and two clients per agency pass isolation and membership-revocation tests |
| 2 — Requests | Client portal, staff queue, public/internal comments, attachments, assignments, state machine | Client request reaches staff, feedback and revision approval work, internal data stays private |
| 3 — Reporting | Google consent/resource binding, daily sync, bounded backfill, GA4/Search Console dashboards | Reports show correct totals, source dates, freshness, gaps, and reauthorization states |
| 4 — Delivery visibility | GitHub App/webhooks, issue/PR links, Cloudflare adapters, previews and production verification | One real request is linked to a PR, reviewed at a SHA, deployed by the existing pipeline, verified and completed |
| 5 — Pilot and hardening | Failure recovery, permissions review, accessibility, monitoring, restore drill, runbooks | Pilot acceptance suite passes; all release blockers resolved or explicitly excluded |

Additional later features include optional issue-creation automation, protected workflow dispatch, report exports, anomaly detection, billing, and AI drafting. Each addition needs its own permissions and data-exposure review. Automated DNS changes and autonomous production code changes require separate designs.

### 16.1 Post-MVP: client web health and channel reporting

All items in this subsection are **post-MVP**. They extend the initial GA4/Search Console reporting and Cloudflare deployment visibility; they do not expand the first-release acceptance criteria. Priorities below are recommendations, and provider capabilities must be revalidated during implementation. Research reference date: 2026-10-28.

Build a client health view spanning visibility, visitor experience, reliability, security, and business results. Enable channel-specific modules only for clients who use those channels. Show actionable findings, supporting observations, collection time, and coverage limitations. Present separate health indicators rather than an unexplained combined score.

#### Recommended delivery order

| Post-MVP increment | Scope | Completion evidence |
|---|---|---|
| A — General website health | PageSpeed, CrUX where available, selected URL Inspection, Cloudflare traffic/error/security aggregates, direct availability checks | An authorized client can distinguish traffic, performance, indexing, and operational problems; missing data is explicit |
| B — Local business presence | Business Profile listing, performance, and review visibility | Multiple locations map correctly to a client; access approval and broad OAuth scope are handled safely |
| C — Client-specific channels | Google Ads, Merchant API, YouTube, and AdSense as relevant | Resource-specific permissions, metric definitions, currency/timezone, and reporting boundaries are verified for each enabled module |
| D — Deeper staff diagnostics | Tag Manager inspection, selective Logpush, Web Risk, richer correlation and alerts | Staff can investigate findings without exposing raw logs, credentials, or another client's information; retention and costs are controlled |

#### Google integrations

| Integration | Planned capability | Constraints and implementation notes |
|---|---|---|
| PageSpeed Insights | Scheduled mobile/desktop Lighthouse audits of representative pages and checks after releases | Store tested URL, device/strategy, audit time, Lighthouse version, and diagnostic results. Keep lab results separate from real-user results. [API guide](https://developers.google.com/speed/docs/insights/v5/get-started) |
| CrUX and CrUX History | Real-user Core Web Vitals and URL/origin performance trends | Low-volume sites may have no eligible data. Preserve collection windows and source granularity; use CrUX directly rather than depending on PageSpeed's embedded field data. [CrUX API](https://developer.chrome.com/docs/crux/api/), [History API](https://developer.chrome.com/docs/crux/history-api) |
| Search Console URL Inspection | Indexing, crawl, and canonical observations for selected landing pages and recently changed URLs | This extends the existing integration. It reports Google's known indexed information and does not perform a live page test or guarantee reindexing. Budget inspections instead of crawling every URL through this API. [Overview](https://developers.google.com/search/blog/2022/01/url-inspection-api) |
| Business Profile APIs | Listing details, Search/Maps visibility, website clicks, call-button clicks, direction requests, and review visibility | Requires project approval and authorized access to each profile. Map multiple locations explicitly. Call clicks are not completed calls or confirmed leads. Performance access uses `business.manage`; initially enforce reporting-only operations in the application. [Prerequisites](https://developers.google.com/my-business/content/prereqs), [capabilities](https://developers.google.com/my-business/content/faq), [performance authorization](https://developers.google.com/my-business/reference/performance/rpc/google.mybusiness.performance.v1) |
| Google Ads API | Paid acquisition and campaign performance reporting for advertising clients | Start with reporting only. Check current project access levels and OAuth/account access. As of the research date, the access-policy page describes the September 2026 developer-token sunset; older setup pages may still describe tokens. Resolve requirements against current documentation before implementing. [Access policy](https://developers.google.com/google-ads/api/docs/api-policy/access-levels) |
| YouTube Data and Analytics APIs | Channel/video inventory and authorized audience/engagement reporting; eligible revenue reporting separately | A public channel URL does not grant private analytics access. Validate channel ownership/access and request only required scopes; monetary reporting is separately authorized. Do not treat video views as website visits or leads. [Analytics reports](https://developers.google.com/youtube/analytics/reference/reports/query) |
| AdSense Management API | Publisher earnings/performance, site inventory, alerts, and policy issues | Enable for publishing clients. Preserve report currency, timezone, completeness, and relevant site filters. Keep publisher earnings distinct from Google Ads advertising activity. [API reference](https://developers.google.com/adsense/management/reference/rest) |
| Merchant API | Product eligibility, processed product status, and account/product issues | Enable for ecommerce clients with Merchant Center. Map merchant accounts and products to permitted client scope. Start with diagnostics, not product mutations. [Product diagnostics](https://developers.google.com/merchant/api/guides/products/list-products-data-issues) |
| Tag Manager API | Staff inspection of published container versions and tag/trigger configuration; configuration-change findings | Use read-only access. A configured tag does not prove that it fires correctly; validate actual behavior in a browser. Publishing tags requires a separate change workflow. [API overview](https://developers.google.com/tag-platform/tag-manager/api/v2) |
| Web Risk | Optional malicious-URL reputation checks for monitored public URLs | Evaluate the commercial-use API and applicable costs/terms. A clean result is not proof of a secure site. Google directs commercial threat-detection use cases away from non-commercial Safe Browsing. [Safe Browsing guidance](https://developers.google.com/safe-browsing/reference) |

Business Profile review replies, listing edits, advertising changes, tag publishing, and merchant product changes remain outside the initial reporting modules. Any later write capability needs explicit authority, audit records, and the applicable provider-policy workflow.

#### Cloudflare data collection

Use three complementary paths, implemented as provider adapters behind the existing Rust application services:

1. **GraphQL Analytics:** Query `https://api.cloudflare.com/client/v4/graphql` for authorized aggregated datasets. Start with hostname-scoped HTTP traffic/bandwidth and available status-code, cache, and timing breakdowns; firewall events; exact-Worker request/error/execution metrics; and Web Analytics/RUM when enabled. Candidate nodes include `httpRequestsAdaptiveGroups`, `firewallEventsAdaptive`, and `workersInvocationsAdaptive`. Validate actual fields and filters against the accessible schema. [GraphQL overview](https://developers.cloudflare.com/analytics/graphql-api/), [hostname queries](https://developers.cloudflare.com/analytics/graphql-api/tutorials/end-customer-analytics/), [firewall events](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-firewall-events/), [Workers metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
2. **REST configuration snapshots:** Inspect DNS/proxy configuration, certificate state, hosting mappings, and existing deployment evidence. Compare approved configuration with observed state and report unexpected changes. Supplement certificate API observations with an external HTTPS handshake check. [DNS API](https://developers.cloudflare.com/api/resources/dns/), [certificate API](https://developers.cloudflare.com/api/resources/ssl/subresources/certificate_packs/methods/list/)
3. **Selective Logpush:** Export detailed request/security logs into controlled storage for clients needing deeper investigation. As of the research date, Logpush is available across Free, Pro, Business, and Enterprise plans with usage-based pricing; dataset access depends on enabled products. Check current availability and pricing instead of assuming an Enterprise-only feature. [Availability](https://developers.cloudflare.com/logs/faq/general-faq/), [pricing](https://developers.cloudflare.com/logs/logpush/pricing/)

**Capability discovery:** At connection time and periodically afterward, inspect GraphQL schema/settings for enabled datasets, available fields, retention, query duration, and page-size limits. Store a capability snapshot for the exact account/zone and gracefully disable unsupported reports. Use resource-scoped API tokens and separate reporting credentials from mutation authority. [Settings discovery](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/), [token configuration](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)

**Resource isolation:** Extend site bindings with Cloudflare account ID, zone ID, explicit authorized hostnames, Worker identity, and RUM identity where applicable. Never expose a shared zone/account aggregate as one client's data. Account-wide logs must be partitioned into validated client/site scope before any client-facing query or export.

**Collection defaults:** Start operational aggregate jobs every 5–15 minutes, configuration snapshots daily, and deployment reconciliation more frequently during active releases. Treat these as configurable pilot defaults, not provider freshness guarantees. Store report definition, half-open time window, dimensions/filters, source units, sampling/completeness, and collection timestamp. Check GraphQL errors even on HTTP success, stage complete results before publication, and use the existing bounded retry and quota controls. [Limits](https://developers.cloudflare.com/analytics/graphql-api/limits/), [errors](https://developers.cloudflare.com/analytics/graphql-api/errors/)

**RUM:** Discover accessible Web Analytics/Web Vitals datasets and require beacon setup where necessary. Preserve measurement and sampling metadata; do not silently combine Cloudflare browser measurements with CrUX or lab audits. [Web Analytics FAQ](https://developers.cloudflare.com/web-analytics/faq/), [measurement updates](https://developers.cloudflare.com/changelog/product/web-analytics/)

**Log controls:** Use private object storage, bounded retention, compression and asynchronous processing, access checks, and redaction/minimization of IP addresses and sensitive URL components. Establish a budget and volume cap before enabling exports. Keep raw request logs staff-only by default. Cloudflare analytics are operational observations, not authoritative billing figures.

#### Direct monitoring and health findings

Provider APIs must be supplemented with scheduled public HTTPS checks, redirect validation, robots/noindex checks, sitemap accessibility, selected broken-link checks, and safe tests of critical forms. Avoid creating real customer transactions or sending production notifications during synthetic tests. Reuse the existing URL-fetching SSRF defenses and authorized hostname allowlists.

Extend the logical schema with:

- `integration_capabilities`: agency/connection/resource, supported datasets/fields, limits, discovery time.
- `health_checks` and `health_check_runs`: authorized target, check kind, schedule, result, timing, sanitized evidence, and release reference where available.
- `health_findings`: agency/client/site, category, severity, source observations, first/last seen, freshness, status, assignee, and linked change request.
- `log_export_configs`: authorized dataset/resource, private destination reference, retention, budget, and ingestion cursor; no embedded credentials.

Reuse `provider_connections`, explicit resource bindings, versioned reports, durable jobs, audit events, and scoped API patterns. Introduce additional provider-specific bindings when a business location, channel, merchant account, or advertising account cannot be represented safely as a site analytics property. A business location or channel may serve several sites; represent that relationship explicitly rather than duplicating its totals across sites.

Example findings include an observed production error increase after a release, an important landing page not indexed, missing tracking configuration, a certificate issuance problem, or deteriorating mobile experience. Correlation supports investigation and does not prove causation. Each finding should expose a clear next action, with staff triage before automatically opening client-visible work.

#### Post-MVP acceptance requirements

- New integrations are opt-in, reporting-only initially, and enforce current agency/client/resource access on collection, display, export, and disconnection.
- Missing eligibility, missing permission, unsupported dataset, sampled result, stale observation, zero activity, and provider failure remain distinct states.
- GA4 sessions, Cloudflare requests, Search Console clicks, Business Profile actions, video views, and advertising results retain separate definitions. Never sum them into a common visitor or lead total.
- Approved clients cannot see another client's hostnames, locations, channels, accounts, or raw logs, including within shared provider accounts.
- Performance reports identify lab versus real-user measurement, source window, device, units, and granularity. Trends preserve changes in report definitions and provider methodology.
- Alerts include freshness, supporting evidence, configurable thresholds, deduplication, and recovery handling. An unconnected optional integration must not lower a client's health assessment.
- Provider quota, retention, consent, credential revocation, and export-cost failure paths are verified before enabling each module in production.

## 17. Acceptance criteria

The MVP is accepted only when the following are demonstrated, including failure paths:

1. **Agency isolation:** A user in agency A cannot list, read, update, download, export, or infer protected resources from agency B by substituting IDs. Composite references cannot link across agencies.
2. **Client isolation:** Client A cannot access client B inside the same agency. Assigned staff cannot reach unassigned clients unless granted all-client access. Revocation takes effect without waiting for session expiry.
3. **Credential isolation:** Browser assets, API responses, logs, attachments, job payloads, and test fixtures contain no provider secrets. Two concurrent connection refreshes cannot lose a rotated token.
4. **OAuth correctness:** Wrong-state, expired-state, replay, mismatched agency/user, revoked membership, and missing granted scopes are rejected or handled safely. Declined consent does not destroy an existing working connection.
5. **Reporting correctness:** Fixture-backed tests prove non-additive period users, weighted CTR, report-grain consistency, property timezone handling, preliminary data labels, zero versus missing data, and inaccessible shared-property filtering.
6. **Report durability:** A failed middle page of a backfill leaves the last complete report available. Retrying does not duplicate observations. Provider outage shows stale data with an explanation.
7. **Workflow safety:** Invalid transitions and stale versions fail predictably. Client approval binds to a SHA and becomes invalid after revision changes. Client approval alone cannot publish production code.
8. **Visibility:** Internal notes and operational details never appear in client responses, notification payloads, search results, exports, or attachment grants.
9. **Webhook safety:** Invalid signatures are rejected; duplicate and out-of-order events do not duplicate work or regress authoritative state. Unknown installations/repositories cannot select arbitrary agency scope.
10. **Deployment evidence:** Preview success and PR merge cannot complete a request. Completion records the correct production target, release identity, and verification. Failed production release remains actionable.
11. **Job recovery:** Killing a worker after job claim or after remote success demonstrates safe lease recovery and reconciliation without duplicate external effects. Quota exhaustion backs off without starving other agencies.
12. **Uploads and fetches:** Unauthorized download attempts fail; dangerous uploads remain quarantined; URL fetches cannot reach private/link-local destinations through redirects or resolution changes.
13. **Usability:** A client can find a report and submit a request on mobile and with keyboard navigation. Staff can triage, assign, share a preview, and close verified work without manual database edits.
14. **Operational recovery:** A restore drill meets agreed RPO/RTO. Expired tokens, removed GitHub access, Cloudflare permission loss, database outage, and stalled queues have actionable staff diagnostics.
15. **Performance:** In an agreed pilot load profile, target cached API reads at p95 under 500 ms excluding client network time; asynchronous acceptance does not wait for provider completion. Record dataset, concurrency, and environment so this target is testable, not a blanket guarantee.

## 18. Guidelines for AI coding agents

Use this section as standing implementation context for an AI developer working in the eventual repository.

1. Read repository instructions, existing architecture decisions, schema, and tests first. Treat this document as proposed design; identify conflicts with implemented contracts before changing behavior.
2. Work in small vertical slices: migration, domain policy, persistence, application use case, HTTP contract, UI, and meaningful verification. Avoid scaffolding every future module at once.
3. Preserve the chosen stack: Rust/Axum/SQLx/Tokio/PostgreSQL and Nuxt/Vue/TypeScript. Do not substitute another framework, ORM, database, or Workers runtime without a documented decision.
4. Verify dependency APIs in primary documentation. Pin compatible versions and toolchains. Never fabricate crate methods, provider endpoints, permission names, quota numbers, webhook events, or deployment guarantees.
5. Every use case needs explicit principal and tenant/client/site scope. Do not infer permission from a supplied UUID, email domain, repository owner name, installation ID, or frontend route. Add composite constraints and negative access tests.
6. Parameterize SQL. Keep RLS context transaction-local. Use real PostgreSQL in integration tests; SQLite cannot establish PostgreSQL RLS, locking, or job-claim correctness. If using SQLx checked macros, generate offline metadata from the intended schema and check it in CI.
7. Keep domain errors typed and map them to stable public codes. Do not use `unwrap`/`expect` in fallible production request/job paths. Add operational context while redacting secrets.
8. Bound async concurrency and queues. Do not hold mutex guards or database transactions across provider network requests. Move unavoidable blocking work off runtime threads; a detached `tokio::spawn` must not be the sole record of required work.
9. Put retries, rate limiting, timeouts, pagination, and token refresh in shared adapter infrastructure. Preserve operation idempotency and retain source metadata. Do not add hidden provider calls to dashboard rendering.
10. Keep provider DTOs behind adapters and frontend types aligned to OpenAPI. Use explicit visibility-specific response types so internal fields cannot leak through generic serialization.
11. Never log or commit secrets, broaden provider scopes to bypass an error, disable certificate verification, weaken CSRF/CORS, or grant client users staff capabilities to make a feature work. Surface the real missing prerequisite.
12. Keep request submission, approval, merge, deployment, and verification distinct. Never auto-publish code because a client comment, repository file, webhook text, or AI response asks for it.
13. Add meaningful tests for authorization boundaries, workflow transitions, analytics math, durable-job failure modes, and provider contracts. Avoid tests that merely mirror implementation or rely on live credentials. Include permission-denied, revoked-token, timeout, and partial-pagination fixtures.
14. Use safe migrations, least-privilege database roles, reversible application changes, and reviewed resource allowlists. Do not provision paid resources or change production infrastructure merely to complete a local development task.
15. Validate Rust formatting/lints, relevant tests, frontend types/build, migration safety, and dependency checks appropriate to the change. Report what was actually run and what remains unverified.
16. Finish each change with a concise review summary: user-visible outcome, key design decision, changed contracts/migrations, test evidence, and material limitations. Keep implementation documentation updated.

## 19. Decisions to resolve during phase 0

These do not prevent initial scaffolding, but must be settled before the affected feature or production pilot:

- Native Rust service host, managed PostgreSQL, private object store, identity provider, and transactional notification delivery mechanism.
- Static Nuxt portal versus SSR, the same-origin routing mechanism, supported toolchain versions, and actual dependency compatibility.
- Actual client hosting mix: Pages Git integration, Pages Direct Upload, Workers deployment workflows, and external sites.
- Whether client approval is required per site/request type, who has release authority, and what production verification entails.
- Existing Google property ownership, tracking quality, consent configuration, dedicated versus shared properties, and Google app verification readiness.
- Retention/deletion periods, support-access policy, service objectives, RPO/RTO, initial pilot load, and accessibility expectations.

Preserve the core boundaries while resolving these details: clients see only their authorized data, provider credentials remain server-side, durable work survives restarts, and production delivery follows an explicit reviewed workflow.
