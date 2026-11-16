# Provider request extension 1.1.0

This additive profile closes the provider **definition/conformance** gap in
[HTP #34](https://github.com/hatchertechnology/htp/issues/34). Backend delivery is
scheduled under that same literal issue now, with t2 owning the isolated
`feat/provider-request-lifecycle` implementation. Backend author delivery is
[PR45](https://github.com/hatchertechnology/htp/pull/45) at
`edd55b83059122fbb3d83781be7e567e1680bbc9`; its author reports SQL 27/27,
API 23 auth + 5 MCP, format and isolated PostgreSQL concurrency checks passing.
Those are author results; the coordinator reports both exact-head backend
reviews approved and PR45 merged as
`48485a55773b1ca97e165a4715d343704270266e`; backend postchecks are pending.
That merge does not establish contract acceptance, deployment or host activation. This document does not declare
implementation accepted, deployed, or supported by any host package.

The immutable `../v1/` inventory, fixtures, locks and host descriptors preserve
contract 1.0.0 and its accepted pins. 1.1.0 extends that baseline with
`provider-requests.json`, lifecycle traces and a current shared-source skill
lock. Existing unkeyed `request_website_report` calls retain their legacy
registration/extension behavior. No caller UUID is required. SEOsmith execution
and its separate operation identity are unaffected by this extension.

## Public wire contract

Discover all tools and input schemas through the authenticated MCP connection.
Enable this profile only when the deployed lifecycle backend and the optional
`request_key` input plus both new tools have been verified. A missing tool/input
is unsupported. Tool discovery alone does not certify backend migration or
semantic acceptance. Never emulate withdrawal by deleting a website,
disconnecting a provider, or removing a shared job.

| Tool | Input | Effect and success |
| --- | --- | --- |
| `request_website_report` | Existing `website_id`, `kind`, optional `property_id`, `start_date`, `end_date`; optional new `request_key` | With key, atomically register/reconcile intent. Return `collection`; saved report fields are best-effort and may be absent. Without key, preserve existing behavior. |
| `get_website_report_request` | `website_id`, `request_key` | Read-only reconciliation; return `{collection}`. No new intent, deadline extension, collection registration or provider call. |
| `cancel_website_report_request` | `website_id`, `request_key` | Idempotently withdraw this intent; return `{collection}`. No provider call or saved-data deletion. |

A keyed success has this collection object (surrounding saved report fields are
outside this profile):

```json
{
  "collection": {
    "requestKey": "review-2026-11-16",
    "status": "accepted",
    "expiresAt": "2026-11-23T00:00:00Z",
    "association": {
      "provider": "google",
      "kind": "analytics",
      "propertyId": "123",
      "startDate": "2026-11-01",
      "endDate": "2026-11-15",
      "fqdn": "example.test"
    }
  }
}
```

`website_id` scopes every call; `(website_id, request_key)` is durable caller
identity. The key is non-secret ASCII `[A-Za-z0-9._~-]`, 1–128 bytes, case
sensitive. No UUID format requirement applies to it. A key reused on another
website is a different identity and still requires that website's authorization.
The association is an existing **shared job natural key**, not a fresh run ID:
Google uses website/FQDN/kind/property/start/end; Bing uses website/FQDN with
`provider: bing`, `kind: bing` and explicit null `propertyId`, `startDate`,
`endDate`. Google undated source associations use `1970-01-01` sentinel dates;
`properties` and `business_locations` use an empty property string on accepted
associations. These have different input rules: properties ignores supplied
property IDs, while business_locations accepts only an empty effective property
(null/omitted coalesces to empty). A new business_locations intent with a nonempty
property is INVALID_ARGUMENT. Reusing an existing key with a changed nonempty
property is CONFLICT because signature comparison precedes new-source validation;
the original intent and association remain unchanged. The supplied nonempty
property is never silently ignored or normalized into a successful registration.
All six association fields are present; the website scope is supplied by the
request rather than repeated in the collection object.

The immutable intent signature is kind, effective property string, and original
supplied date values. Null and omitted dates compare equally. Properties/Bing
ignore supplied property IDs and store an empty string; other property strings
are compared exactly (no whitespace or leading-zero normalization). Supplied
versus omitted dates conflict even if resolving omission would yield the same
range. Google undated associations normalize dates to sentinels while retaining
the original date arguments in that signature. Bing's range is a saved-report
selection, not its shared job identity. Retrying omitted Bing dates on a later
UTC day uses the original intent and never creates or renews collection based
on a newly resolved rolling range. Saved read presentation can vary with time;
the intent and public job association remain stable.

## Lifetime, retries and reconciliation

New intent starts `accepted`, expires seven days after registration transaction
time, and retains the fixed `expiresAt`. `accepted` means eligible subscription
intent, not queued/running/completed collection or a promise of fresh data.
Provider connection, permission, quotas and scheduling still constrain work.
Read stored sources/snapshots separately for coverage, provider errors and data.

An identical same-key retry returns the same association and deadline, including
when expired/withdrawn, and creates no duplicate intent/job or renewal. Changed
signature under an existing key returns CONFLICT and leaves the original intact.
An intentional renewal or new collection uses a new key; it can associate with
an already existing job. Status is only `accepted`, `expired`, or `withdrawn`.
At `now >= expiresAt` an unwithdrawn intent is expired. Withdrawal before expiry
remains withdrawn thereafter; cancelling an already expired intent returns
expired. Terminal retries never revive an intent. Website binding/FQDN changes
do not rewrite retained intent associations or bypass same-key conflict checks.

After a timeout/lost response/UNAVAILABLE, registration may have committed.
Lookup by the same website/key reconciles it without collecting anything.
If lookup returns NOT_FOUND for the authorized website, retry the original
request with the same key. Do not infer that a transport failure rolled back,
replace the key, or silently renew. A successful registration must return
`collection` even when the subsequent best-effort saved-data read fails.

## Withdrawal, concurrency and retained data

Creation, changed-input conflict and withdrawal serialize per website. Two
concurrent identical creates register one identity; changed concurrent inputs
produce one winner and CONFLICT for the other. A cancel ordered before creation
returns NOT_FOUND and does not reserve a tombstone or cancel a future intent.
A cancel ordered after creation withdraws it; subsequent same-key retries remain
withdrawn. Claim/withdrawal ordering must be tested against the actual backend.

Withdrawal removes only this intent's future contribution to eligibility after
its transaction commits. It does not revoke a lease already acquired, promise
interruption/completion, erase an observed provider result, withdraw another
key, or disable independent scheduled/legacy work. Shared active intents keep
the job eligible; withdrawal of the last keyed intent removes only keyed
eligibility. Scheduled jobs may continue even when every keyed intent is terminal.
Retain saved snapshots/reports and intent identities. Website deletion keeps its
separate destructive authorization and cascade semantics.

## Bounds and errors

Maximum 100 active keyed intents and 1,000 retained identities per website.
Terminal identities remain reserved until website deletion; there is no automatic
key eviction or reuse window. At either cap reject a new key with LIMIT_EXCEEDED.
Existing retries/read/cancel remain usable at the caps. Cancellation can free an
active slot but does not free a retained identity slot. These are hard finite
bounds; no implication of unlimited future renewal is made.

Preserve PR40 validation/collection limits, including 366 inclusive date days,
100 active Google ranges, ten active sampled URLs and explicit seven-day
eligibility. Undated sentinel exceptions remain source specific. Keyed limits
add to existing job limits rather than replacing them. A shared natural-key job
can be reused without consuming another job row; a new intent still consumes an
intent slot. Errors and lookup create no collection work.

Executed MCP lifecycle failures set `isError: true`, with bounded
`structuredContent: {"code": CODE}`. No provider response, SQL text, credentials,
or unbounded diagnostic is included in this lifecycle error payload.

| Code | Meaning and next action |
| --- | --- |
| INVALID_ARGUMENT | Invalid key/provider/source/range input. Correct an unregistered request; do not change an already registered identity's signature. |
| NOT_FOUND | Missing request or unavailable website authorization target; do not infer existence or another owner's data. |
| CONFLICT | Existing key has different signature. Reconcile original; use a new key only for deliberate new intent. |
| LIMIT_EXCEEDED | New intent/job would exceed a bound. Existing identities remain readable/retriable/withdrawable. |
| UNAVAILABLE | Sanitized backend failure; registration may be uncertain. Lookup/retry the same key. |

Keyed calls with an unknown string `kind` return bounded structured
INVALID_ARGUMENT without echoing the supplied string; advertised discovery
retains the valid enum. Framework argument deserialization still precedes the
lifecycle handler for malformed website UUIDs and wrong JSON field types. These
can return MCP `isError: true` with a content deserialization diagnostic and no
`structuredContent.code`. This is a framework-level argument rejection, not a
structured lifecycle INVALID_ARGUMENT result. Preserve that rejection distinctly
and do not infer registration. The INVALID_ARGUMENT trace covers
invalid keys/source/range inputs reaching the lifecycle handler; it does not assert that the framework emits
the lifecycle envelope. Retain original wire evidence and use a bounded sanitized
normalization diagnostic rather than copying arbitrary content into errors.

Authentication may fail before tool execution; preserve the MCP/transport auth
failure and use interactive sign-in. Do not reclassify masked NOT_FOUND as
FORBIDDEN. The trace format has local AUTH_REQUIRED/UNSUPPORTED (and reserved
FORBIDDEN only with explicit evidence); these are normalization outcomes, not
claims that the SQL RPC emits them.

## Current shared-source readiness

The current canonical source/1.1 lock is verified here. Existing three-host pins
remain historical 1.0.0 evidence and do not certify current 1.1 source parity.
Claude's actual shared skill copy requires a reviewed companion update; Codex/Pi
require separate pinned 1.1 readiness artifacts and vendored-source hash checks.
Keep old v1 pins immutable. Those companions synchronize gated definitions and
readiness; they do not implement host runtime, install skills, certify OAuth or
activate a backend. Current parity must not be claimed until exact reviewed
companion revisions and their checks are recorded.

## Conformance and release evidence

Run with Node 22+:

```sh
node scripts/check-plugin-contract.mjs
node --test scripts/plugin-contract.test.mjs scripts/provider-request-contract.test.mjs
node scripts/check-plugin-contract.mjs --provider-results /path/provider-results.json
```

Twenty-seven synthetic traces cover Google/Bing association, exact retry, new-key
renewal/shared jobs, conflicts, expiry boundary/terminal status, response loss
with/without commit, unknown keys, key/website isolation, auth/capability denial,
key/range/cap rejection, cancellation serializations, shared/scheduled/leased
work and retained data. The initial v1 golden checker remains available unchanged
in semantics through `--results`; it is not a varied semantic validator.

Input kind/property/range are cross-checked against the normalized public
association; actual dates are parsed independently (not from an invalid-input
flag). TTL, intent caps and inclusive date bounds come from the profile. Source
ownership/binding validation and existing Google range/sampled-URL job budgets
remain backend acceptance obligations covered by PR40/45 tests; this trace
validator does not model those inventories. Website deletion/release is the
separate destructive baseline operation; this suite does not execute deletion
or prove cascade behavior.

The new validator checks semantic invariants without comparing observed results
to golden expected objects. Tests mutate expected and observed values together
to exercise assertions independently. It accepts lawful variation in keys,
transaction times and associations. A trace is a sequential serialization;
it does not execute a real concurrency or lease race. Fixture self-checks remain
synthetic specification evidence, not proof of database writes or runtime safety.

External format is `{contractVersion: "1.1.0", host, observations}` where host is
`backend`, `claude`, `codex` or `pi`; observations are `{id, steps, context?}`
using every canonical scenario ID. Each observation step is
`{id, collection, error, effects}` plus `workAfter` only on designated
withdrawal steps; collection is the normalized wire object or null; error is null or `{code}`. Effects contain six bounded counters as shown
in fixtures. On uncertain submission failure, intent/job creation counts are
null, never invented zero. Lookup/withdrawal cannot create intents/jobs even
when unavailable. Other counters cover provider claims initiated by the
call (required zero: these tools register/read/withdraw and never execute a
provider claim), saved deletion, other withdrawals and schedule cancellation, not concurrent
unrelated worker activity. Normalize timestamps to millisecond UTC ISO strings;
retain the original wire/DB evidence separately.

For measured acceptance runs supply `context` on **every** trace. Omitting it
selects the original synthetic fixture context, which is useful for self-checks
only and must not be represented as measured acceptance. Context has exactly
`{evidenceRefs, steps}`. The 1 MiB input-file cap applies to the whole envelope;
there are at most 128 scenarios, 128 steps per trace and 16 evidence references
per context. Each reference is a non-secret 1–512 character identifier/path to
independently retained wire/DB evidence; the checker neither opens it nor proves
its authenticity. Evidence must establish transaction time, effective input
signature, public association, authorization and measured effects independently
of the returned collection. Do not copy observed result values into context as
proof of themselves.

Each measured context step has exactly `{id, now, request, association}` with
`request: {websiteId, requestKey, input}`. Copy the canonical step IDs/order;
supply the registration transaction clock as `now` and later call clocks for
retries/read/withdrawal. Supply the measured website/key and normalized intent
signature described above. On lookup/cancel this input is retained harness
metadata for the identity, not an additional wire argument. The canonical signature object field names, kind and
null/omitted-date roles are retained. For the designated `uncertain.committed`
loss step only, an additional `committedAfterLoss` collection seed is required,
backed by independently retained transaction evidence. The designated shared
and last-keyed withdrawal steps additionally require measured `workBefore` and
observed `workAfter`, each exactly
`{leasedClaims, scheduledJobs, activeOtherIntents, savedSnapshots}` with integer
counts 0–10,000. Preserve the canonical zero/positive presence cases. These
counts cover only the target scope and must remain equal across withdrawal;
independent worker activity must be isolated by the harness. This checks the
reported lease/schedule/other-intent/snapshot preservation, including withdrawal
of the last keyed intent, but cannot detect falsified or unmeasured effects. The loss seed must have the measured key/association, accepted status and the fixed deadline. Success seeds are
forbidden everywhere else.

For example a measured retry/read trace can include:

```json
{
  "evidenceRefs": ["evidence://local-pg/run-7/transactions-and-wire.json"],
  "steps": [
    {
      "id": "create",
      "now": "2026-12-16T10:00:00.000Z",
      "request": {
        "websiteId": "8f000000-0000-4000-8000-000000000001",
        "requestKey": "pg17~run.7",
        "input": {"kind":"analytics","propertyId":"900123","startDate":"2026-11-01","endDate":"2026-11-15"}
      },
      "association": {"provider":"google","kind":"analytics","propertyId":"900123","startDate":"2026-11-01","endDate":"2026-11-15","fqdn":"measured.example.test"}
    }
  ]
}
```

The example shows one step; a real envelope must supply all steps for every
canonical trace plus corresponding observations. The CLI tests demonstrate a
complete envelope with different keys, FQDN, property, transaction dates and
15/17-second retry/read measurements instead of fixture day spacing.

Measured context cannot override actions, authorization/failure/capability/cap
predicates, shared-job flags or expected assertion coverage. Cross-step website,
key, signature and association equality **and distinctions** must match the
canonical scenario. Kind/provider/null/sentinel and maximum/invalid-key cases
remain fixed. Context clocks are ordered and must preserve pre/post-expiry cases
and the exact expiry-boundary test. Context edits that erase conflicts, collapse
websites, switch cancellation into lookup, bypass owner/cap errors, change a
retry association or inject a successful reconciliation seed are rejected.

The optional isolated source probe below loads every migration from the exact
backend merge revision recorded in `provider-requests.json`, using that checkout's
already installed pinned PGlite test dependency. It verifies new nonempty
business_locations input is INVALID_ARGUMENT, changed existing input is CONFLICT,
null/empty coalescing, unchanged original intent, and shared job counts. It enables
Business Profile only in its disposable fixture to reach source validation. It
never connects to a deployed database or provider and is separate from the
no-dependency conformance suite:

```sh
node scripts/probe-provider-business-locations.mjs --backend-root /path/to/backend
```

The validator trusts supplied context (counts, ownership, transaction time,
association and any committed-after-loss seed). It does not verify provenance,
measure side effects, execute SQL/MCP, or prove scheduler eligibility. Real
acceptance must obtain those facts independently from database/worker evidence,
and test both legal claim/withdrawal orderings. No host adapter is implemented.

Release requires reviewed exact backend commits with SQL/API/MCP owner/isolation,
conflict/retry/lost-response/caps and claim/withdrawal/shared scheduling tests;
then authorized migration/deployment and real schema discovery. Backend work
remains scheduled under #34 until accepted evidence is recorded. Host releases
must repin reviewed canonical 1.1.0 source/skill hashes, refresh capabilities,
and verify their own auth/normalization paths. Existing Claude/Codex/Pi pins
remain historical 1.0.0 evidence and are not silently promoted. Disable producer
activation on rollback and preserve backend reads/cancellation of retained
identities and saved evidence. This profile does not close #34 or satisfy the
separate install/login/upgrade/rollback/minimum-version host gates.
