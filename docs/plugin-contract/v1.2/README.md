# Audit export profile 1.2.0 — definition, activation gated

This profile adds export-v1 to the accepted 1.0.0 and provider-request 1.1.0
profiles. It defines a deliberate migration for large audit detail callers.
Small `website_audit_detail` calls retain their complete existing structured
result and text content. Unsafe large inline materialization returns an explicit
error requiring a new workflow. Unchanged callers cannot retrieve those large
results. No truncation or success-with-omissions is allowed. Version 1.2.0 names
the new capability profile; it does **not** promise backward compatibility for
large inline callers. Export tool names and their representation are versioned.

The backend export implementation is separate and not yet accepted/deployed by
this change. `audit-exports.json` records the baseline and a null export backend
revision until independently accepted evidence exists. REST PR47 acceptance is
not MCP export acceptance. No tools, SQL, runtime or vendor service are added by
this contract PR. Rediscover deployed tools and input schemas before use. Missing
support is unavailable, never an empty report or permission to collect new data.

## Frozen wire

Required inputs use `website_id` and `delivery_id` UUIDs. Chunk/close additionally
use case-sensitive `exportId`; chunk requires nonnegative integer byte `offset`.
There is no client-selected chunk size. Framework parsing may reject malformed
inputs before the handler. Authentication middleware can reject absent, invalid
or anonymous authentication with HTTP 401 before a structured tool envelope.

| Tool | Success `structuredContent` |
| --- | --- |
| `website_audit_export_start_v1` | `{version:1,exportId,websiteId,deliveryId,representation:"htp.audit-detail-json.v1",byteLength,sha256,chunkMaxBytes:262144,expiresAt,idleExpiresAt}` |
| `website_audit_export_chunk_v1` | `{version:1,exportId,offset,dataBase64,nextOffset,eof,byteLength,sha256,idleExpiresAt}` |
| `website_audit_export_close_v1` | `{version:1,closed:true}` |

Successful tools use `isError:false` (or the SDK's omitted false default).
Normalized conformance observations make false explicit. Descriptors contain
opaque snapshot IDs, no subject IDs, bearer tokens or private paths. UUIDs in
start output must match the requested target; `sha256` is lowercase hexadecimal
SHA-256 over all snapshot bytes, and `byteLength` is their exact length. Integers
must be represented exactly by clients; reject unsupported precision rather than
round an offset or length. Times are RFC3339 instants.

Start makes one immutable snapshot of the **complete original saved detail JSON
response bytes**, including delivery/scan/received/ingestion metadata, summary,
`report`, `report_json`, and any additional saved fields. Ready is returned only
after clean EOF and complete strict JSON validation. It must not reserialize or
filter the detail document. The snapshot hash verifies transfer consistency,
not authenticity of the original crawl, an ingestion receipt, or original raw
report hash. After reconstruction, decoded nonnull `report_json` is the exact
original retained string; null explicitly means original raw was not retained.
`report` then provides stored JSONB evidence, never fabricated original syntax.
Historic raw and stored values may diverge; preserve both without reconciliation.

Chunk reads at most 262144 bytes from this snapshot. Base64 permits UTF-8 to split
across chunks. `nextOffset = offset + decoded byte count`, `eof` is true exactly
at total length. Offset equal to length succeeds with empty base64, unchanged
nextOffset and eof true; greater than length is INVALID_ARGUMENT. Retrying a
valid offset returns identical bytes, hash, length and ID until expiration;
its idle timestamp can change. Clients concatenate decoded bytes, verify full
length and SHA, then parse text/JSON. They must not mix snapshots or claim a full
review from partial bytes. Authorized close is idempotent even after missing,
expired or previously closed snapshots; inaccessible/deleted target still fails.

## Access, lifetime, resources and errors

Each call authenticates a nonanonymous subject and freshly checks current
website ownership/FQDN and delivery existence/relationship. A snapshot is bound
to its preparing subject, target and instance; possession of its ID is not auth,
and a new website owner cannot read the previous owner's snapshot. A current
owner supplying a foreign or unknown snapshot ID receives EXPORT_EXPIRED
uniformly. Authorized close remains closed:true without disclosing or deleting
a foreign snapshot. The prior owner fails fresh target access with NOT_FOUND. Revocation,
deletion or FQDN changes must prevent subsequent data disclosure. A read already
authorized before a concurrent revoke may finish; backend tests must establish
the authorization/read ordering. Close also requires current target access.

Initial idle lifetime is 15 minutes, hard lifetime two hours from creation.
Successful chunks set idle expiry to min(now+15min,hard expiry). Hard expiry never
extends. Start replay for the same owner/website/delivery reuses the live snapshot
and hard deadline; any idle refresh remains bounded. Expired/lost snapshots are
not resumed automatically. A new start means a new ID and a new reconstruction.

Handler failures set `isError:true` and structuredContent
`{code,exportVersion:1,message}`. EXPORT_REQUIRED additionally contains
`startTool:"website_audit_export_start_v1",websiteId,deliveryId`.
There are no frozen `retryable` or `restart` response fields. Preserve sanitized
error text/status; never turn errors into missing-success evidence.

| Code | Meaning / client action |
| --- | --- |
| EXPORT_REQUIRED | Unsafe large inline result; explicitly use the discovered export-v1 workflow. |
| EXPORT_EXPIRED | Expiry, restart, wrong instance, missing/closed/foreign snapshot; explicitly start again and discard prior partial bytes. |
| EXPORT_CAPACITY | Temporary admission, concurrency or storage capacity; explain and retry later if useful. No report-size compatibility guarantee. |
| UNAVAILABLE | Upstream, IO or strict-validation failure; no ready snapshot; preserve failure. |
| INVALID_ARGUMENT | Invalid values reaching handler, including offset beyond length; correct inputs. |
| NOT_FOUND | Masked authenticated owner/website/FQDN/delivery denial or absence; no report data. |

Cancellation before ready yields no successful descriptor, cleans partial storage
and returns UNAVAILABLE if a response is still possible, otherwise transport
cancellation. Client-disconnect, malformed/truncated upstream, filesystem full,
TTL/close and process lifetime must not leak accessible snapshots or sensitive
paths. Private service-owned storage, bounded buffers, admission/concurrency and
aggregate disk accounting are backend obligations. Temporary capacity is finite;
no arbitrary report is guaranteed to fit available storage/time. Instance-local
storage needs verified routing/topology or explicit documented restart-on-loss;
nonsticky multi-instance routing can prevent completion. No separate vendor
export service or new approval flow is part of this profile. Saved detail and
all export operations create zero provider collection jobs and zero crawl runs.

## Offline semantic conformance and evidence limits

Run from the canonical tree with Node 22+:

```sh
node scripts/check-plugin-contract.mjs
node scripts/check-audit-export-contract.mjs
node --test scripts/plugin-contract.test.mjs scripts/provider-request-contract.test.mjs scripts/audit-export-contract.test.mjs
node scripts/check-audit-export-contract.mjs --export-results /path/results.json
```

The default generates synthetic observations and validates them semantically.
It executes no backend or host. Tests supply corrupt bytes/hashes, offset/EOF,
identity/deadline drift, denial/error erasure, unwanted collection and context
mutations to prove rejection. Generating observations is a fixture helper, not
an export implementation. Fixture size is chosen to cross transport boundaries,
not to reproduce production peak memory.

External input is exactly `{contractVersion:"1.2.0",host,observations}`, host one
of backend/claude/codex/pi. Every canonical scenario appears exactly once as
`{id,steps}` for synthetic context or `{id,context,steps}` for measured context;
mixed context modes are rejected. Each step is `{index,result,effects}` matching
the fixed canonical action/control sequence. Normalize the actual MCP result to
`{isError,structuredContent}`; normalize middleware denial to `{httpStatus:401}`,
framework invalid input to `{rpcError:-32602}`, disconnected cancellation to
`{cancelled:true}`. Control steps have null result. Effects are independent
integer counts `{collectionJobsBefore,collectionJobsAfter,crawlRunsBefore,crawlRunsAfter}`
for the isolated tested scope. Before/after must be equal; existing work may be
nonzero. Counters must be measured outside the tool output.

Measured context fields are exactly:

```json
{
  "evidenceRefs": ["evidence://isolated-run/source-wire-controls-and-counters"],
  "originMs": 1794787200000,
  "websiteId": "00000000-0000-4000-8000-000000000001",
  "deliveryId": "00000000-0000-4000-8000-000000000002",
  "owner": "isolated-owner-subject",
  "other": "isolated-other-subject",
  "bytesBase64": "...complete independent source detail bytes..."
}
```

Context supplies a controlled-clock origin, actual isolated target/subjects and
source detail bytes captured **independently of export output**. The fixture's
`afterSeconds` advances that controlled clock; exact deadline-boundary cases
require a controllable backend test clock. The fixed control events must actually
transfer ownership, delete delivery, rename target or restart the instance in the
isolated harness. They are not caller-supplied validity flags. Context cannot
change actions, offsets, error predicates, source null/divergence cases, or erase
coverage. The matching raw case requires parsed report equality plus a distinct
original raw string representation; divergent raw requires unequal parsed values.
The large trace reads all chunks in order with an intentional retry, checks
empty EOF and past-end error, then idempotent close. This harness requires full
prefix coverage before accepting EOF as a completed reconstruction;
the wire itself permits arbitrary valid byte-offset reads. Every chunk is checked
against source bytes and a separately computed hash; completed reconstruction is
checked again. Source context is at most 4MiB per trace and CLI input 32MiB as
**offline validator bounds**, never backend report limits. Production-scale
acceptance needs separate full-stream tests beyond this compact transcript.

References identify evidence; they cannot prove provenance. A fabricated context
can pass semantic checks. “Measured context supplied” is not proof of actual
measurement, cleanup, owner isolation, cancellation or no collection. Reviewers
must independently inspect source captures, control/authorization records,
database counters, cancellation/temp-file/FD/disk records and resource profiles.
The varied-context unit tests remain fabricated tests, not measured evidence.

## Migration, source pins and readiness

Historical v1 and accepted1.1 artifacts, locks and host pins remain byte-for-byte
unchanged. `historical-v1.1-source/` archives exactly the four accepted1.1 skill
files, checked against the old immutable lock. Current source uses the new1.2
lock. The old profiles continue to describe their accepted revisions; changing
source does not silently promote any host pin or deployed backend.

After reviewed canonical merge, three coordinator-owned companion readiness PRs
must preserve each old pin and add a separate1.2 lock/vendor tree. Required
canonical paths: this profile README/JSON/conformance/source-lock, the three
`audit-export-*.mjs` modules, standalone checker, `scripts/plugin-contract.mjs`
(readJson dependency), and all four skills/reference files in the new lock.
Reuse the validator; verify exact file hashes/pin, host-specific results target,
semantic/drift negatives and synthetic/measured labeling. Claude must also update
actual shipped shared skills and verify them against the1.2 lock. Codex/Pi remain
vendored-source readiness only until installable runtime work separately ships.
No host edits belong to this canonical PR. Record exact canonical/backend/three
companion commits and checks centrally before claiming current source parity.

Feature availability additionally requires accepted exact backend source/tests,
256MiB cgroup (including page cache) and concurrency/cancellation/storage/strict
validation evidence, actual endpoint full reconstruction/raw/null/metadata and
access/error tests, deployed compatible backend, routing/storage verification,
and fresh schema discovery. Contract tests do not establish those facts. Host
installation/OAuth/runtime/upgrade/rollback gates remain separate. Roll back
activation and shared-source packages to a verified pin while preserving stored
reports and compatible reads; do not delete data to restore compatibility.
