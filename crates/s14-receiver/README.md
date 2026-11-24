# Worker-only S14 receiver skeleton — phase one

This isolated implementation is deliberately incomplete and cannot admit4. It is
not a frozen candidate, production receiver, native privilege proof or deployment.
The experimental POST route in apps/api/src/s14_worker.rs is unconditionally
unavailable and does not poll/decode the body. No env setting, DB gate, proof
writer, commit adapter, owner import, direct schema4 RPC, migration or capability
advertisement is added. Existing deployed contracts are unchanged.

The receiver-owned crate checks exact raw byte cap, UTF-8/JSON syntax, decoded
unique keys,64-container depth, string bounds (64KiB only at the exact embedded
policy path), typed metadata/unsigned integer spellings, bound canonical policy,
request bounds and the chosen URL profile. It uses bounded sequence decoders and
retains opaque source as RawValue, including legal numbers beyond f64, without
applying a global count/status key heuristic. Fixture bytes are hashed/pinned.

`inspect` returns only InspectedCandidate. It intentionally does NOT certify
page-field/source completeness, registered catalog equality, record predicates/
facts, source pointers, scope/entity/manifest digests, omitted-state reconstruction,
coverage or compatibility projections. Some source fields are ignored in this
inspection phase. `validate_for_admission` always returns
SemanticValidationNotImplemented after inspection. ValidatedS14 has no public
constructor; nothing can issue a proof or acceptance receipt. Independent full
receiver semantics and raw typed-path coverage are the next implementation phase.

The role/deadline modules are standalone decision models, not SQL grants, RLS,
triggers, session pinning or measured cancellation. They model current worker/
session requirements, revoked-validator original receipts, default-off new rows,
writer/operator separation and remaining global time. No native DB is installed
or contacted by this phase's tests.

## Sol r2 findings incorporated before candidate review

Review: coordination/reviews/wave1-s14-worker-api-r2-sol-9aeb02fa-458e5020.md.

1. Grants alone do not establish access for new nonowner NOBYPASSRLS owners. The
   role model denies when either the SQL grant or explicit RLS row access is
   absent. The next DB phase needs this effective table/role/operation matrix:

| Existing/new RLS table | New NOLOGIN execution roles requiring explicit policy | Operations to qualify |
| --- | --- | --- |
| websites/bindings | guard owner; proof owner for bounded context reads if used | SELECT visibility; guard row-lock access with needed column UPDATE privilege and matching policies; no exposed UPDATE routine |
| seosmith_audits | commit owner | SELECT for authenticated UUID/conflict lookup; INSERT restricted to worker4 + trigger-bound provenance; no UPDATE/DELETE |
| private pending proofs | proof owner and commit owner | bounded SELECT/INSERT; commit DELETE consumption; no API direct DML |
| private gate/revisions | proof/commit/guard owners as needed | SELECT/guard lock only; operator owns activation/revocation |

Policies must target only new NOLOGIN owners, preserving owner/legacy/service1/2
behavior. Do not add BYPASSRLS, table ownership or auth/service memberships to API
roles to make tests pass. Effective inherited/PUBLIC/default ACLs and row policies
need real native tests; this matrix and Boolean model are not proof they work.

2. A session lock bounds ordinary contention only while the backend lives. On
   loss it can release before Rust CPU stops, allowing a second process to start.
   The model fences commit when the original session is lost. Cancellation and
   lost-session/second-process races remain unimplemented/unqualified. Initial
   runtime scope is one S14-serving instance; no global<=1 validator or HA claim
   across disconnect is made. Do not release the local permit just because a
   future was dropped. Shared slot acquisition/release, SQL cancellation and
   retained CPU occupancy require later controlled native tests.

## Next bounded phases (not implemented)

Complete independent receiver semantic equality against a successor consistent
URL bundle; then implement static private role/RLS/proof/commit SQL and session/
body/gate adapters in a disposable native DB. Retain default-off API/operator DB
admission, concurrency1/queue0 and reserved cleanup budget. Implement only one
owned stored detail path; broad owner/history/UI/lifecycle and producer emission
stay outside scope. No production migration version is reserved. No push or gate
activation is authorized by this skeleton.

### Local consistency experiment

`check_consistency` compares the embedded candidate catalog and manifest rule metadata
with the pinned registry, and counts retained records per rule against the manifest's
claimed candidate count. It checks eligibility, attempt and outcome distributions only
when that rule has no omissions. These are consistency checks on report claims: manifest
candidates, omitted counts and retained record predicates are **not** reconstructed from
pages. Unknown-reason distributions, completeness, omission reasons, record identities,
locators, observed facts, source scope and manifest digests are not verified. Policy
canonical bytes and digest remain independently reconstructed by `inspect` from request,
config and version fields, but the config's provenance is not independently established.
The consistency function materializes only a projection of fields used by the rules;
opaque source values are skipped. It does not establish resource/cancellation qualification. It is local test evidence,
not an admission path; `validate_for_admission` remains unconditionally closed.

`check_scalar_advisories` separately reconstructs the six advisory rows from
stored pages and the retained policy: ordered entity and record IDs, applicability,
Unicode scalar lengths, thresholds, record fields, the shared 512-record cap and
full coverage distributions, including omitted candidates. It compares exact
manifest rows, emitted records and coverage. Its success certifies only those six
rows relative to the supplied page fields and policy; it does not certify source
truth, URL scope authorization, duplicate entities, other rules or overall record
ordering. It uses the same local projection as the consistency experiment and cannot
issue admission authority.

`check_reconstructed_rules` adds the remaining observation and explicit-intent
rows and external-link occurrences, including source/target availability (external-link source requires successful HTML
without block, error or truncation), facts,
pointers, candidate order, the 128-observation and 512-record caps, omission
reasons, full row coverage, and global record order. Duplicate same-kind entities
and ambiguous referenced targets are rejected. It compares the registry through
`check_consistency`. This is still a local reconstruction experiment, not an
admission validator: scope and manifest digests, full source schema and interval
validity, source authenticity, website authorization, resource budgets and prompt
cancellation are not certified. Projected JSON materialization and repeated target lookup
are not qualified for maximum valid inputs. Existing admission stays closed.

`check_source_bindings` independently reconstructs the declared website/generation
scope digest and sorted manifest-definition digest, and validates the inherited
report interval against the bounded RFC3339 subset with full fractional ordering.
The manifest hash deliberately excludes candidates; `check_reconstructed_rules`
checks candidate populations separately. A matching scope digest binds report claims,
not authenticated website ownership, FQDN, current binding or source truth. Inspection retains opaque JSON as borrowed raw spans; the binding check deserializes only its typed fields and ignores opaque source values. The rule checks materialize selected source and comparison fields rather than the complete report. This check is separate from admission and is not resource or cancellation qualified.

## Offline compatibility finding check

`check_compatibility_findings` independently enumerates the six scalar advisory
findings and the noindex and redirect findings gated by explicit policy intent,
using page observations and the S14 policy config. It compares their population
and key, rule, severity, URL, evidence, evidence items and classification, and
checks the eight legacy rules removed unconditionally by producer `policy.rs` are
absent. It does not infer a violation from an observation or advisory. It checks
multisets, not global ordering; additional finding/detail properties are ignored.
It also reconstructs inherited `deep_page`, `slow_ttfb`, `large_image`,
`incorrect_media_type`, `http_scheme`, `underscore_url`, `space_url`, and
`multiple_slashes`, including flag-generated evidence and the six standard
legacy detail fields. Other inherited populations and global ordering remain
unchecked; retained source fields make more reconstruction possible. The bounded input inspection precedes the
check; selected finding fields and the rule projection are allocated, and neither
peak resources nor cancellation during serde passes is qualified. It preserves the
original receipt bytes and does not create admission authority.

The retained schema-4 producer reports have no summary field. The historical
`seosmith_legacy_summary` SQL defines counts and other summary fields for schema 1,
and the version-4 summary wrapper accepts only schemas 1 and 2. Schema 4 now has a
separate receiver-owned derivation, described below; it does not reuse or change
the schema-1/2 version-4 adapters. Full source validation, legacy finding
reconstruction, authorization, provenance, service resources and independent
exact-head review remain open.

## Schema-4 finding coverage

`finding_coverage` validates the optional top-level `finding_coverage` extension
(`{version, audit, checks}`) and verifies an absence claim against the pinned
producer audit + policy finding population. The `full_population` module
independently recomputes that population from the retained pages, request scope
and retained policy config without reading `report.findings`; it covers all 85
pinned audit rules plus the three policy-only ids, and reproduces the policy
retain/replace/remove transformations, keys, severities, ordered de-duplicated
evidence (2000-item cap), detail fields and multiplicity. The extension is
checked before absence is interpreted: unique sorted rule ids bounded by the
88-id catalogue, known status strings, and `audit: complete` covering every
catalogue rule as complete. A per-rule `complete` is verified only when that
rule's prerequisite holds and its expected multiset equals the retained findings;
a verified empty expected set is the only clean result. Item-local rules (for
example `missing_h1`) need the page-local prerequisite only: retained pages are
observed, a successful HTML page and the usable seed are present, and no page is
truncated. Deliberately aligned with the pinned producer, that prerequisite does
not require a completed crawl, so a complete local check survives an unrelated
partial external edge and remains scoped to retained pages. Every policy row for
the rule must also be complete; a rule can carry several rows (for example
`noindex` and `http_redirect` observation plus policy-violation rows). The
supplied row `complete`/`omitted` labels and counts are not trusted on their
own: before a per-rule policy claim or a global audit claim is certified, the
candidate manifest and coverage rows are independently rebuilt from the
retained pages and links with `check_reconstructed_rules` and
`check_consistency`, including record/observation caps and omission states. A
missing, renamed, miscounted or otherwise malformed row fails closed, and a
queried policy rule is forced through the pinned policy catalogue so a removed
supplied row cannot pass vacuously. Graph rules
need that row check plus actual retained-graph traversal: internal link targets,
resource relationships, redirects, canonicals and alternates must all be
observed; external targets count only when external checking is enabled and the
target is retained; missing or ambiguous targets stay unknown. Traversal follows
the pinned producer gates exactly: `html` requires a 2xx status and an HTML
media type, extracted links are consulted only for successful HTML pages, and
redirect, canonical, alternate and resource-relationship targets are checked on
every retained page, including non-HTML 301 responses and resources. `audit: complete`
additionally needs every catalogue check complete, a completed frontier-exhausted
fully-covered crawl including the seed page and all resources observed, unique
page identities, and full-population equality. Absent
extension, an unsupported version, an absent check, a malformed or omitted policy
row, or an unverifiable prerequisite leaves absence unknown rather than clean;
a contradicted `complete` claim fails closed with `SemanticMismatch`. Retained
positive findings stay visible regardless of coverage, and a verified `complete`
population is not a globally clean report. Coverage is relative to the retained
crawl and establishes nothing about unobserved pages, true server responses,
extraction accuracy, authenticity, authorization or provenance. The vendored
producer fixtures under `tests/fixtures/s14-finding-coverage-v1/` are additive and
byte-pinned; no historical fixture or service route changed.

## Receiver-owned schema-4 saved summary (version 5)

`derive_saved_summary` is a local-only derivation from receiver-validated retained
schema-4 input. It does not open the worker route, contact a service, or replace
the schema-1/2 version-4 summary adapters. It first runs the existing inspection,
source-binding, consistency, reconstructed-rule, compatibility-finding and batch
coverage checks. It then derives a compact canonical JSON summary from the same
retained report.

`finding_coverage_batch` verifies all 88 pinned catalogue rules in one pass: it
parses retained findings once, projects the source once, caches the item/global
source prerequisites, and reproduces the expected population at most once. It
does not rescan the report once per rule. A rule is `complete_verified` only when
its extension check is complete, its policy rows are complete, its source
prerequisite holds, and its retained finding multiset equals the independently
reproduced expected multiset. A partial or absent claim remains
`unknown_partial`; a contradicted complete claim fails closed. A retained finding
stays visible regardless of coverage. The summary never presents an unverified
flag as clean.

### Version and fields

The emitted summary is `summary_version: 5` for schema 4 only. Schema 1/2 keep
the existing version-4 adapters and cache. The canonical object contains:

- `summary_version`, `schema_version`, `wire_contract_version` (`s14-wire-1`),
  `evidence_contract_version` (`null` for schema 4), `evidence_state`
  (`policy_versioned`), `engine_version`, `ruleset_version`, `started_at`,
  `finished_at`, `outcome`, `stop_reason`.
- `crawl_coverage_complete`, `evaluation_coverage_complete`, `coverage_complete`
  and `audit_coverage`. `crawl_coverage_complete` is recomputed from retained
  pages, not trusted from the report flag. `evaluation_coverage_complete` is true
  only when the batch audit is `complete_verified`. `coverage_complete` is true
  only when both are true. `audit_coverage` is `complete_verified` or
  `unknown_partial`.
- `policy_digest`, `manifest_digest`, `scope_digest` and a derived
  `comparison_key` binding the wire contract, policy digest and manifest digest.
- `pages` and `resources` observation counts (`checked`, `html`, `images`,
  `http_errors`, `fetch_errors`, `blocked`), `findings`, `severities`, `rules`,
  `record_counts` (`observation`, `advisory_triggered`,
  `advisory_not_triggered`, `violation`, `no_violation`, `not_applicable`,
  `unknown`), `omitted_records`, `omitted_observations`.
- `rule_coverage`, one entry per pinned catalogue rule with
  `coverage` (`complete_verified` or `unknown_partial`) and
  `reported_findings`.

### Limits and unsupported case

The canonical summary is UTF-8 JSON and is capped at 16 KiB (`16_384` bytes).
The derivation rejects a larger canonical summary with `SummaryTooLarge`; it never
truncates or silently drops a rule. The input report still uses the existing
bounded inspection limits. A non-schema-4 input is rejected with
`UnsupportedSchema`; schema 1/2 are not derived by this function. The summary is
bounded metadata, not a replacement for the retained raw report. It does not
certify source truth, crawl coverage beyond the retained pages, authenticity,
authorization, provenance or production admission.

### Determinism, digests and verified claims

The canonical summary is compact UTF-8 JSON emitted by the pinned Rust
`serde`/`serde_json` serializer for `SummaryV5`: struct fields follow declaration
order and every map is a `BTreeMap`, so object keys are sorted and the bytes are
deterministic. This is not RFC 8785 JCS; reproduce the digest with this exact
serializer or from the committed fixture bytes. `SavedSummary.sha256` and
`SavedSummary.source_sha256` use the explicit `sha256:<lowercase-hex>`
representation, and `source_bytes` is the exact retained input length. The fixture
`manifest.json` stores bare lowercase hex in its own `source_sha256` and
`summary_sha256` fields, so compare it with an explicit `sha256:` prefix rather
than string equality.

Two different claims are reported side by side and must not be conflated:

- `audit_coverage` (with `evaluation_coverage_complete` and `coverage_complete`)
  is the report-level aggregate. It is `complete_verified` only when the whole
  pinned population was independently reproduced and the global prerequisite
  holds.
- `rule_coverage[<rule>].coverage` is a per-rule claim. It is
  `complete_verified` only for that rule's independently reproduced population and
  prerequisite and stays `unknown_partial` otherwise. A `complete_verified` audit
  does not imply every rule is complete, and a `complete_verified` rule does not
  imply the report is globally clean. `reported_findings` is the retained
  observation count and is always visible regardless of coverage.

### Export and reproducible fixtures

`SavedSummary` exposes the summary `Value`, the exact canonical `Vec<u8>` bytes, a
`sha256:<hex>` digest over those bytes, and the retained-source binding
(`source_sha256` and `source_bytes`) that produced it. The source fields are
returned beside the canonical bytes and are not part of the emitted summary wire
object, so the committed summary-v5 fixture bytes are unchanged. The example
prints the canonical bytes and both digests:

```sh
cargo run --offline --locked -p htp-s14-receiver --example saved_summary -j1 -- \
  crates/s14-receiver/tests/fixtures/s14-finding-coverage-v1/complete-clean-h1.json
```

The byte-pinned fixtures and their source/summary digests are under
`tests/fixtures/s14-saved-summary-v1/`. `manifest.json` records the source path,
source bytes/SHA-256, summary path, summary bytes/SHA-256 and case name. The
`tests/saved_summary.rs` regression regenerates each summary, byte-compares it,
checks the digest and enforces the 16 KiB ceiling. See that fixture README for the
generation command and scope.
