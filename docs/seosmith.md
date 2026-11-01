# Seosmith audit ingestion and history

HTP stores each Seosmith run as an immutable audit document. It retains the
original UTF-8 report bytes, parsed JSON, checksum, scan time, receipt time,
ingestion method and a compact derived summary. Repeated delivery is idempotent;
a different report with the same run UUID is rejected. There is no automatic
run retention deletion. Monitor database/storage usage as history grows.

## User experience

Overview → Technical SEO opens independently of Google/Bing connections and the
Google date picker. The history chart includes all loaded audit dates, plots by
exact scan completion timestamp, and keeps multiple same-day runs separate.
Load older runs follows a timestamp-plus-UUID cursor; history remains available
beyond the first page. Reports missing original timestamps stay in history but
are excluded from the chart.

Choose findings, severity totals, URLs checked, HTTP errors, or findings per 100
URLs. Hollow points identify incomplete observations. Lines and finding-change
comparisons require complete coverage and matching engine, ruleset, and crawl
configuration. A partial run cannot make an issue appear resolved. Counts are
observations, not an SEO score or a guarantee of search rankings.

Select a run for severity/rule/text filters and checked URL inspection. JSON
report downloads preserve original bytes so re-importing the download is
idempotent. Imported content is escaped and only HTTP(S), credential-free URLs
become links.

## Worker push

`POST /integrations/seosmith/audits` accepts the version-1 envelope documented in
Seosmith's README: delivery UUID, lowercase SHA-256 and `report_json` string.
Use `Authorization: Bearer <website-scoped worker token>` and an
`Idempotency-Key` matching the delivery UUID. The database validates the token
hash, enabled state, website ID, binding generation, FQDN, hash, schema and limits.
A receipt is returned only after the database transaction commits.

Provision `seosmith_bindings` through the privileged database management path.
Store only the token SHA-256 in HTP, and the raw generated secret in Seosmith's
secret mount/SOPS. Do not place Supabase service-role credentials on a crawler.
Rotate/disable a token to revoke access, and increment generation for changed
bindings/configuration. One Seosmith instance currently has one scoped token.

## Import local scans

Select the exact website in HTP, then use **Import JSON report**. The signed-in
owner can import a report whose seed hostname matches the selected website.
This path maps a local-only website UUID to the owned HTP record while preserving
the original request, run UUID and bytes. It does not require a worker credential.
Report files are limited to 16 MiB. Other owners and anonymous accounts cannot
import or read a report. Website renames hide previous-FQDN runs from the new
hostname's dashboard; website deletion follows the existing cascade policy.

## API

User-authenticated routes:

- `GET /websites/{id}/seo/audits?limit=50&before=…&before_id=…`: compact history,
  `has_more`, and a cursor. Both cursor components are required together.
- `GET /websites/{id}/seo/audits/{run}`: one original report and its summary.
- `POST /websites/{id}/seo/audits/import`: `{ "report_json": "…" }`.

Nuxt proxies only these fixed routes using the current verified user token.
Worker ingestion is separate from user-JWT middleware and authenticates against
the website-scoped secret inside the ingestion RPC. No additional frontend or
API environment secrets are needed.

## Release and verification

1. Apply `20261031053344_seosmith_audits.sql`, then
   `20261031053413_seosmith_history.sql` and
   `20261031053524_seosmith_explicit_function_privileges.sql` before deploying the API/frontend.
2. Deploy the Rust API and Nuxt frontend together using the existing Fly apps.
3. Provision a worker binding or import local JSON reports.
4. Verify exact receipts, retry deduplication, summary counts, history pagination,
   owner/cross-owner access and the technical SEO dashboard.

Local checks: Rust workspace tests and strict Clippy; PGlite migration/integration
suite; frontend typecheck, Vitest and production build. Playwright validation uses
the real 500/1000-cap www.kerryhatcher.com reports in an isolated PGlite database,
with fixture browser authentication/proxy transport. It verifies two separate
chart points, partial coverage, metric/run switching, finding filters, four HTTP
error URLs, duplicate import, website-switch isolation, desktop/mobile overflow,
and console health. Browser plugin is unavailable, so regular Playwright is used.

The permissions migration explicitly revokes role grants supplied by Supabase's
default function privileges. Anonymous access remains only for the separately
authenticated worker ingestion function. RLS with no table policies is intentional:
clients use checked RPCs, never direct table access.

Released on 2026-10-31: all three migrations applied to HTP Supabase and both
existing Fly apps deployed. Imported the original 500-cap and 1000-cap
www.kerryhatcher.com reports as two distinct historical runs. Both original
checksums match stored bytes. The expanded run has 521 checked URLs and 646
findings. Production smoke tests used an isolated test account and temporary
website (removed afterward), verifying owner import, idempotent retry, original
bytes, real zero counts, history/detail, no-store responses, anonymous API/RPC
rejection and cross-owner rejection. Worker token provisioning remains an
operational step for each crawler/website binding.

## Expanded extraction contract (SEOsmith 0.2.0)

Issue #3 is supported by `20261101054016_seosmith_expanded_evidence.sql`.
Apply this migration after the three audit migrations above before using expanded
reports. The production rollout and verification are recorded below.
Schema version stays 1; engine `0.2.0` uses ruleset `2026-11-01.1`.

Ingestion and imports retain the entire JSON document, including relationships,
header canonical/hreflang, refresh/encoding/language observations, JSON-LD and
nested microdata/itemref evidence, repeated Open Graph/Twitter values, link rel
flags, and finding `evidence_items`/`details`. Detail reads expose the original
parsed report and exact `report_json`; downloads use those original bytes.
Historical reports can omit the additions: missing `is_resource` means a page,
and absent extraction collections mean no recorded observations. Shared frontend
types mark those fields optional rather than rewriting historical documents.
The Rust API forwards opaque JSON without projecting away additive fields.

The common SQL validator permits at most **20,000 page observations plus 20,000
resource observations**, **40,000 combined records**, and **400,000 findings**.
Explicit request budgets must be within 1–20,000 pages and 0–20,000 resources.
These are independent of the unchanged **16 MiB exact-report byte limit**;
inventories that fit the record counts can still exceed the byte limit and must
use smaller crawl scopes. Both worker ingestion and manual import reject a report
before returning an accepted receipt when any limit fails. Raising the byte limit
requires a future coordinated chunk/object-storage protocol that preserves digest
verification, idempotent retry and immutable finalization.

Summaries now separate `pages` and `resources`, each with `checked`, `html`,
`images`, `http_errors`, `fetch_errors` and `blocked` counts. Successful HTML means
any 2xx response with text/html, application/xhtml+xml or
application/vnd.wap.xhtml+xml, ignoring case and charset parameters. Resource
HTML contributes only to `resources.html`. HTP preserves the collector's findings;
it does not apply page metadata or duplicate-content rules to resource HTML.
Historical summaries are derived on read without modifying stored reports, raw
bytes, receipt digests or immutable rows. New summaries carry `summary_version: 3`
and are read from the stored summary to avoid repeating extraction work.

Comparisons still require matching complete coverage, engine, ruleset and the
request comparison key (including `max_resources`). Resource/page limits, legacy
checkpoint metadata, extraction truncation/limit flags, failed or blocked
observations, and relationships whose targets were not observed prevent complete
coverage. Even a claimed `checked` relationship needs a target HTTP response in
the report. Out-of-scope/unfetched targets do not prove successful checks or
resolution of previous findings. Intentional navigation exclusions preserve
configured-frontier coverage; the per-finding safeguards below keep their target
state unknown.

Regression coverage lives in `supabase/tests/seosmith-expanded.test.mjs` with the
shared `supabase/tests/fixtures/seosmith-expanded.json` fixture. The PGlite suite
executes the migration and tests both ingestion paths, legacy reads, role grants,
exact bytes/digests and retries, immutable rows, independent budgets, findings
limits, XHTML/2xx counts and incomplete coverage. Frontend tests verify shared
types and comparison guards; API tests check exact report forwarding and rejected
RPC responses without a successful receipt.

### Production verification — 2026-11-01

Deployed application commit `51cddd5` to both existing Fly apps and applied the
expanded-evidence migration to the HTP Supabase project. Supabase recorded the
migration as version `20261101054016`; the local migration filename matches that
recorded version. The collector was outside this HTP rollout.

- API image: `deployment-01M6ASZHHB80ZXPXTEGW5PMYM4`.
- Frontend image: `deployment-01M6ASZM8W3HFY47QTQE4KWZHK`.
- Both Fly service health checks passed after deployment.
- Re-ran 51 Rust tests, 99 frontend tests and all 8 PGlite integration tests;
  all passed. Frontend typecheck/build and strict API/shared Clippy had also
  passed. Workspace Clippy still reports three pre-existing
  `clippy::assert_is_empty` warnings in `apps/cli/tests/http.rs` with Rust 1.99.1.

Live checks used the existing test account and an isolated temporary website.
Owner import, website-scoped worker ingestion and authenticated frontend proxy
import/history/detail reads preserved all expanded fixture evidence, original
bytes and SHA-256 receipts. Duplicate retries deduplicated; conflicting bytes,
bad digests and over-budget reports failed without accepted receipts. A combined
40,000-record inventory (20,000 pages and 20,000 resources) imported successfully
and remained readable. Page/resource HTML and error counts were separate;
resource limits, extraction truncation and unobserved targets produced incomplete
coverage. Anonymous requests and cross-owner reads were denied.

The temporary website, six test reports and its worker binding were removed.
All seven pre-existing audits remained readable. Their combined fingerprint of
run IDs, checksums, parsed reports and original bytes matched before migration
and after test cleanup; no historical audit documents were rewritten.

### Crawl policy exclusions and finding resolution

The follow-up migration `20261101055407_seosmith_policy_exclusions.sql` corrects
PR #4's P2 review finding. It treats deliberately unfetched navigation as outside
the configured frontier when external link checking is disabled, rel contains
nofollow/sponsored/UGC, a document has robots nofollow/none, or the source is
resource HTML (which does not expand navigation). Relationships retain their
original `outside_scope`/`not_fetched` state. Checked relationships with a missing
response, unexplained missing in-scope targets, blocked/failed targets, and actual
partial/truncated runs remain ineligible for comparisons.

Completeness of the configured frontier does not prove every target was checked.
Finding comparisons now require the current source observation before resolving
an absent finding. Target-dependent rules also require every previously observed
target instance to have a current response. A navigation edge conclusively
removed from complete source extraction can resolve its previous finding without
fetching the former target. Historical findings without recoverable target
URLs stay unverified, and current redirect chains must be fully observed.
The dashboard reports unverified findings separately from resolved findings, so
skipped targets cannot appear fixed while source-only metadata improvements
remain comparable.

Summary version 3 is cached for new reports. History and detail reads recalculate
older cached summaries without altering reports, raw bytes, digests or immutable
rows. The comparison key and engine/ruleset compatibility rules are unchanged.
