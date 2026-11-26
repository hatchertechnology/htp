# Shared HTP and SEOsmith plugin contract

The accepted version 1.0.0 baseline is the Wave 0 source of truth for Claude Code, Codex CLI and Pi.
The JSON inventory in `v1/capabilities.json` records actual bindings, effects,
authorization, bounds, result descriptions, versions and activation gates.
`v1/hosts/` records observed host versions, transport/auth differences and package
readiness. Minimum supported versions remain unverified. No full host package is
created here. Existing HTP package functionality is documented in ../mcp-seo.md.

The additive [provider request profile 1.1.0](v1.1/README.md) now defines
caller intent/job association, retry, reconciliation and scoped withdrawal with
versioned semantic traces. Backend PR45 is delivered/merged separately under #34; backend postchecks,
contract acceptance, deployment and host activation remain distinct gates. The original `v1/`
artifacts and accepted host pins remain historical 1.0.0 evidence. Accepted1.1 shared source remains pinned by `v1.1/skills.lock.json` and its
archived source snapshot. Accepted1.2 shared source remains pinned by the frozen
`v1.2/skills.lock.json` and its `v1.3/historical-v1.2-source/` archive. Current
shared source is pinned separately by `v1.3/skills.lock.json`; new workflows
require deployed capability support. The checker validates every archived
scenario set and the current source lock. It does not promote an old host pin to
the extension.

The [audit export profile 1.2.0](v1.2/README.md) defines an additional versioned
start/chunk/close workflow with full bytes/hash, owner revocation, lifetime and
error semantics. Small audit detail results stay complete and unchanged; unsafe
large inline results explicitly fail with EXPORT_REQUIRED. This requires client
migration and does not promise unchanged large-inline compatibility. Backend
export implementation, deployment/endpoint acceptance and all three current-source
readiness companions remain gated; contract checks prove no feature availability.
Historical v1/accepted1.1 artifacts and host pins remain unchanged.

The [audit read profile 1.3.0](v1.3/README.md) adds two owner-scoped stored reads,
`website_audit_events` and `website_operational_episodes`, with an explicit
`availability:producer_unavailable` state, a paired persisted cursor and held H15
producer gates. The additive operations required a new minor profile instead of
an edit to the frozen 1.0.0 inventory. Historical v1, accepted1.1 and accepted1.2
contract bytes and pins remain byte-for-byte unchanged; the accepted1.2 source is
archived under `v1.3/historical-v1.2-source/` and the current shared source is
pinned by `v1.3/skills.lock.json`. No host pin is promoted and no producer is
enabled.

The [parity read profile 1.4.0](v1.4/README.md) adds three owner-scoped stored
parity reads and an additive amendment of the 1.3.0 audit-read `availability`
field in `v1.4/audit-read-availability.json`: six event producer codes and two
operational codes, with `producer_unavailable` kept as the held value. Only
`producer_active` lets an empty page be read as no events or episodes; every
other code means events may be missing or delayed. The frozen 1.3.0 bytes and
validator are unchanged and still reject the new codes, no host pin is promoted
and no producer is enabled.

## Authorization and discovery

HTP uses the host's interactive OAuth flow against the secured MCP endpoint.
Discover tools and input schemas at connection time; a missing tool is unsupported,
never an empty successful read. Preserve sanitized MCP isError/status information.
Website access must be checked by HTP on every call; a shared hostname does not
prove ownership. Expired HTP auth requires sign-in. Disconnected provider auth does
not remove saved history. Never place tokens in packages, prompts, logs or reports.
Provider grants and privileged worker credentials stay outside host packages.

Saved-data reads must create zero collection jobs. request_website_report is an
explicit provider collection write, not durable SEOsmith scan scheduling. The
1.0.0 unkeyed baseline has no plugin-level durable request identity guarantee;
the gated 1.1.0 keyed extension defines that guarantee separately. URL inspection calls a provider.
Website deletion is destructive; website creation is not safely replayable.

SEOsmith local execution requires explicit scope and a configured executable/private
worker. Local operation remains usable without HTP. Never expose a public crawler.
HTP customer scheduling additionally waits for HTP #7 authorization/orchestration.
The existing private HTTP primitives are not host adapters. SEOsmith #18 proposes
`seosmith --database /absolute/private/run.sqlite operations` with capabilities,
start --request FILE, status/cancel/report --id UUID, and export --id UUID --output
FILE. This remains a gate until its PR is accepted and the adapter is verified.
Its capability output must negotiate adapter_version=1, engine/ruleset/report
versions, operations and limits. One immutable request per isolated database;
retry identical identity/payload, never silently recrawl or mint a new identity.
Changed payload conflicts. Cancellation acceptance is distinct from terminal
cancellation; status separates execution, worker activity, report availability and
delivery. Report/export preserve original bytes; export must not overwrite files.

Report schema v1 remains default. S01 schema v2 is explicitly gated by
--evidence-contract-v2 / SEOSMITH_EVIDENCE_CONTRACT_V2 and deployed compatible HTP
receiver support (#6). Contract major incompatibility fails closed. Preserve
unknown evaluation states, coverage and original report bytes; partial/truncated
reports never imply a passing audit. Disable producer activation first on rollback
and retain receiver compatibility for stored reports and retries.

## Shared skill ownership and synchronization

HTP owns `plugins/htp/skills` (three existing workflows and their reference files).
`v1/skills.lock.json` pins every file by SHA-256. SEOsmith owns operation semantics
and future adapter skills under #18; no new operation skill ships in this change.
Host packages vendor a reviewed HTP commit plus hashes and contract version.
Keep common workflow text byte-identical; put host tool naming, login, paths and
packaging overrides in host descriptors/references, with explicit override reasons.
A common skill change adds or updates the current versioned lock and the HTP skill lock check (host parity checks remain release gates) in the
same release sequence. Breaking operation/result changes normally require a new contract
major and deliberate host migration. Profile1.2 explicitly records the accepted
exception: unsafe large inline detail now requires export-v1 and existing large
callers must migrate; it makes no unchanged-inline compatibility claim; additive operations require a minor release.
Corrections to documentation/fixtures use patch versions and reviewed re-pinning.

## Executable conformance

Use Node 22 or newer, with no dependencies:

    node scripts/check-plugin-contract.mjs
    node scripts/check-audit-export-contract.mjs
    node scripts/check-audit-read-contract.mjs
    node --test scripts/plugin-contract.test.mjs scripts/plugin-contract-versioning.test.mjs scripts/provider-request-contract.test.mjs scripts/audit-export-contract.test.mjs scripts/audit-read-contract.test.mjs
    node scripts/check-plugin-contract.mjs --results /path/results.json

The checker verifies HTP tool inventory against source, historical/current shared skill hashes, three
host descriptors and the 1.0.0 38 synthetic normalized scenarios, plus the
1.1.0/1.2.0/1.3.0 versioned profile traces and archived-source locks. The latest
supported inventory is the frozen 1.0.0 set plus every additive profile
operation; archived conformance is validated without rewriting it. Tests mutate transcripts to ensure
unsafe results are rejected. The historical v1/provider checker inputs are capped at 1 MiB, 128 scenarios and
16 MiB reported payload size. Export semantic CLI bounds are documented separately
in1.2 and do not impose backend report limits. The checker does not execute hosts, read credentials or
crawl. Expected fixture self-checks are offline specification evidence only.

Host adapter observations use exactly `{contractVersion,host,observations}`;
each observation is `{id,result}`, keyed by canonical scenario id. Result fields
and expected values are in `v1/conformance.json`. Normalization maps actual backend
states to those fields; it must retain raw reports separately. Error codes here
are normalized codes, not a claim that every backend emits identical errors.
External observations are checked for shape and expected semantics, not provenance
or actual absence of side effects. Live verification must independently inspect
job counts, identity, authorization and retained report bytes.

## Distribution and release gates

Claude has an existing HTP-only marketplace package; Codex and Pi have readiness
artifacts, with installable packages deferred to Wave 1. Their descriptors link
official documentation and distinguish observed versions from untested minimums.
Codex CLI OAuth and a managed ChatGPT App connection are separate connections.
Pi evidence uses pinned official 1.5.2 package docs; upstream GitHub doc URLs
returned 404. Claude uses the host's `http` spelling; Pi/Codex use streamable HTTP.

Before each host release, record pinned host/package/contract/backend versions;
validate install, login, HTP read and disconnected-history access, owner denial,
SEOsmith start/status/cancel/report/export, standalone operation, errors/retries,
bounds, upgrade and rollback. Existing offline fixtures do not satisfy those live
gates. Discover capabilities again after upgrades; disable unsupported operations.
Rollback restores the prior verified package/skill lock and capability activation,
preserving history and reports. Claude update/rollback remains unverified in this
baseline. Forms, orchestration, lifecycle, staging, baseline-aware CI and richer
provider analysis activate only after their backend and rollout gates ship.
HTP #34 covers the Wave 0 contract definition, inventory and offline fixtures.
The full #34 issue remains open while its literal checklist criteria are unmet;
offline definition evidence does not certify supported host versions,
upgrade/rollback, parity or durable collection request identity. Host
release issues and backend activation gates remain open pending their own evidence;
no deployment occurs. See [Wave 0 acceptance evidence](acceptance.md).

### Review clarifications

All scenarios carry top-level `evidenceKind: synthetic`. The default checker
compares each golden expected result with itself: it checks fixture consistency,
not host behavior. Only `--results` compares externally supplied normalized
observations, and even that does not verify producer provenance or live support.
These fixtures do not exercise S01 evaluation pass/fail semantics.

`crawlRunsCreated` counts only SEOsmith crawl runs. `collectionRegistered`
separately records HTP provider collection registration; every successful report request
has zero crawl runs and registration true, including ready/stale/error sync states. Saved reads have both zero/false.
HTP `idempotency` and `destructive` mirror MCP annotations and are drift checked.
An idempotency hint does not authorize automatic retry or replace explicit intent.
Import dedupe, explicit delete, and non-owner writes have synthetic scenarios.

SEOsmith host bindings remain null and gated. `primitiveBinding` records
historical implementation details only. The #18 adapter (open PR #19; head may change) uses
the in-process CLI dispatch: `seosmith --database /absolute/private/run.sqlite
operations start --request /path/request.json`, status/cancel/report with
`--id UUID`, and export with `--id UUID --output /new/file`.
Capabilities requires no database. Start is synchronous under lock; exact retries
return existing state without resuming. Cancellation acceptance is distinct from
terminal cancellation. Evidence v2, staging, and CI remain false. Adapter
integration and live host acceptance are still unverified.


### Normalization scope and current behavior

`--results` is an exact synthetic golden transcript match mode. Every field,
including bytes, retryable and code, must match; outcome must be `unknown`.
It cannot validate varied real backend results or S01 pass/fail/inconclusive.
A separate evidence-aware adapter acceptance validator remains a release gate.

`collectionRegistered` means registration or refresh extension occurred, not
that a new row was created. Current request_google_report always upserts
google_report_jobs (migration 20261101060136_page_performance_samples.sql);
ready/stale/error sync state does not undo that write. Repository binding also
initiates background collection. Future read-only report behavior in #32 is
gated and must not be inferred from the current handler.

Normalized statuses are ok, accepted, pending, running, cancelling, cancelled,
error and unsupported. Error codes are bounded lowercase identifiers, not a
complete backend enum. Proposed mappings require adapter evidence:

| Backend evidence | Normalized target |
| --- | --- |
| Explicit unauthorized / authorization_required | auth_required |
| Explicit access_denied for an authenticated non-owner | forbidden |
| website_not_found without ownership evidence | preserve unavailable; do not infer forbidden |
| Private HTTP submit 409 | ambiguous conflict or queue full; no identity_conflict inference |
| Private HTTP report/status 404 | unavailable; no not_ready/absent/expired inference |
| Private HTTP cancel 409 | ambiguous absent or not cancellable |
| CLI status typed state/report_available | preserve observed state; absence proves neither terminal nor clean |

CLI report errors may include run_not_found, report_unavailable, report_too_large,
but stderr reasons are not a complete stable typed taxonomy. Generic DB/IO failures
remain possible. Legacy HTTP outage/auth fixtures are synthetic target cases,
not evidence of local CLI behavior. SEOsmith null idempotency/destructive metadata
means unverified adapter semantics; exact retry expectations do not establish
blanket replay safety. Credentials never belong in host packages.

### Versioned host baseline

The `v1/hosts/` descriptors preserve the initial inspected baseline, including
historical package and adapter wording. Codex now has readiness documentation and
validation scripts (htp-codex PR #3, merged as `e9efb57`); Pi readiness
PR #2 merged as `a3edc71` against canonical PR #36. These artifacts do not implement installable
host packages: `packageStatus: not-implemented` remains accurate. The adapter
implementation described above does not establish host integration. Read historical
install/gate prose in that context. This scope clarification changes no normative
v1 profile, fixture, lock or canonical pin; a future normative correction must be
versioned and coordinated across mirrors.


### Current shared source and readiness

Accepted1.2 source uses the frozen `v1.2/skills.lock.json`, verified against
`v1.3/historical-v1.2-source/`. Current shared source uses `v1.3/skills.lock.json`
and adds the two audit reads. `v1.2/historical-v1.1-source/` still preserves the
accepted1.1 four files for immutable lock verification. The checker verifies
every archived history and the current source. No existing host pin is silently
upgraded. The [1.2 migration/readiness plan](v1.2/README.md#migration-source-pins-and-readiness)
and the [1.3 migration/readiness plan](v1.3/README.md#migration-source-pins-and-readiness)
require three separate host companion changes after canonical merge and exact
backend/deployment/endpoint evidence before availability claims. Actual host
packages and vendored-source readiness are distinct. All export and audit read
operations read saved evidence and create no collection work.
