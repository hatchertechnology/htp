# Shared HTP and SEOsmith plugin contract

Version 1.0.0 is the Wave 0 source of truth for Claude Code, Codex CLI and Pi.
The JSON inventory in `v1/capabilities.json` records actual bindings, effects,
authorization, bounds, result descriptions, versions and activation gates.
`v1/hosts/` records observed host versions, transport/auth differences and package
readiness. Minimum supported versions remain unverified. No full host package is
created here. Existing HTP package functionality is documented in ../mcp-seo.md.

## Authorization and discovery

HTP uses the host's interactive OAuth flow against the secured MCP endpoint.
Discover tools and input schemas at connection time; a missing tool is unsupported,
never an empty successful read. Preserve sanitized MCP isError/status information.
Website access must be checked by HTP on every call; a shared hostname does not
prove ownership. Expired HTP auth requires sign-in. Disconnected provider auth does
not remove saved history. Never place tokens in packages, prompts, logs or reports.
Provider grants and privileged worker credentials stay outside host packages.

Saved-data reads must create zero collection jobs. request_website_report is an
explicit provider collection write, not durable SEOsmith scan scheduling; it has
no plugin-level durable request identity guarantee. URL inspection calls a provider.
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
A common skill change updates the lock and all three host parity checks in the
same release sequence. Breaking operation/result changes require a new contract
major and deliberate host migration; additive operations require a minor release.
Corrections to documentation/fixtures use patch versions and reviewed re-pinning.

## Executable conformance

Use Node 22 or newer, with no dependencies:

    node scripts/check-plugin-contract.mjs
    node --test scripts/plugin-contract.test.mjs
    node scripts/check-plugin-contract.mjs --results /path/results.json

The checker verifies HTP tool inventory against source, shared skill hashes, three
host descriptors and 31 normalized scenarios. Tests mutate transcripts to ensure
unsafe results are rejected. Inputs are capped at 1 MiB, 128 scenarios and 16 MiB
reported payload size. The checker does not execute hosts, read credentials or
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
HTP #34 and host issues remain open pending rollout evidence; no deployment occurs.

### Review clarifications

All scenarios carry top-level `evidenceKind: synthetic`. The default checker
compares each golden expected result with itself: it checks fixture consistency,
not host behavior. Only `--results` compares externally supplied normalized
observations, and even that does not verify producer provenance or live support.
These fixtures do not exercise S01 evaluation pass/fail semantics.

`crawlRunsCreated` counts only SEOsmith crawl runs. `collectionRegistered`
separately records HTP provider collection registration; a pending report request
has zero crawl runs and registration true. Saved reads have both zero/false.
HTP `idempotency` and `destructive` mirror MCP annotations and are drift checked.
An idempotency hint does not authorize automatic retry or replace explicit intent.
Import dedupe, explicit delete, and non-owner writes have synthetic scenarios.

SEOsmith host bindings remain null and gated. `primitiveBinding` records
historical implementation details only. The #18 adapter (#19 PR, ad36869) uses
the in-process CLI dispatch: `seosmith --database /absolute/private/run.sqlite
operations start --request /path/request.json`, status/cancel/report with
`--id UUID`, and export with `--id UUID --output /new/file`.
Capabilities requires no database. Start is synchronous under lock; exact retries
return existing state without resuming. Cancellation acceptance is distinct from
terminal cancellation. Evidence v2, staging, and CI remain false. Adapter
integration and live host acceptance are still unverified.
