# HTP #34 Wave 0 acceptance evidence

The accepted source baseline is PR #36, merge
`3db3e439ec0adc99211d49358a7cb8a29507a940`. This document reconciles
contract-definition evidence with the full issue’s still-open acceptance criteria. The
coordinator owns issue closure and release decisions.

| Issue acceptance area | Evidence and scope |
| --- | --- |
| Shared reuse and ownership | README ownership section, `v1/skills.lock.json`; SEOsmith owns adapter semantics and future skills under SEOsmith #18. |
| OAuth and credential boundary | README authorization policy and host descriptors; no executed login claimed. |
| Host transports | Versioned host descriptors cite official sources and observed versions; minimum supported versions remain unknown. |
| Scheduling and private scope | README requires HTP #7 authorization and configured private execution with explicit scope. |
| Reads, identity, bounds and cancellation | Inventory and fixtures define effects and target semantics. Saved reads create no collection jobs. Provider report requests register collection and have no plugin-level durable identity guarantee. This is an unmet #34 checklist requirement, not a waiver or runtime acceptance. |
| Versioned scenarios | 38 synthetic scenarios and mutation tests provide offline specification evidence only. |
| Distribution and parity | README and descriptors define distribution, upgrade/rollback and synchronization gates; no installation certification. |
| Baseline and deferred capability | Existing Claude HTP-only baseline; Codex/Pi readiness artifacts; host packages remain not-implemented and SEOsmith host bindings null/gated. |

Validation commands:

```sh
node scripts/check-plugin-contract.mjs
node --test scripts/plugin-contract.test.mjs
```

The default checker checks golden fixture consistency. `--results` requires an
exact synthetic golden transcript match, including unknown outcome; neither mode
proves live behavior, provenance, side effects or varied semantic conformance.

Remaining release work belongs to host release tracking and backend issues
HTP #7 (orchestration), #6/#8 (evidence/lifecycle), #20 (parity), #32 (history),
and SEOsmith #18 (adapter integration). It includes varied backend acceptance
validation, minimum host certification, install/login/upgrade/rollback evidence,
adapter execution and production rollout. Codex readiness PR #3 merged at
`e9efb57`; Pi readiness PR #2 merged at `a3edc71` against canonical PR #36. Neither is
proof of a shipped host package.

## Open checklist requirements and ownership

Keep #34 open. Do not check unverified criteria merely because definition evidence
exists. Supported minimum host versions, upgrade/rollback and package parity
remain unverified; delivery is tracked by HTP #33 and host issues
[Claude #1](https://github.com/hatchertechnology/htp-claude/issues/1),
[Codex #2](https://github.com/hatchertechnology/htp-codex/issues/2), and
[Pi #1](https://github.com/hatchertechnology/htp-pi/issues/1).

Durable identity for provider collection remains owned by the open checklist in
[HTP #34](https://github.com/hatchertechnology/htp/issues/34). HTP #7 explicitly
owns durable HTP scan job identity, scope, budgets and cancellation; its current
wording does not establish ownership of provider collection request identity.
Do not treat it as satisfying or waiving the provider gap. Open #34 is the
owning issue for durable provider collection identity, including request/job
association, retry/conflict behavior, bounds, cancellation and error semantics.
No duplicate follow-up issue is needed; retain the unchecked requirement there
until implementation and appropriate backend/MCP evidence satisfy it.

SEOsmith #18 owns operation adapter integration. Backend gates above and live
host evidence remain open. The coordinator must record exact reviewed commits,
validation and evidence for each literal criterion before changing its checklist
or closing #34. This documentation does not authorize closure or alter scope.

## Provider definition/conformance extension (1.1.0)

[Version 1.1.0](v1.1/README.md) defines the finite provider gap identified by
the 2026-11-16 acceptance audit: caller key scoped by website, Google/Bing public
natural-key association, immutable seven-day intent, retry/new intent/conflict,
read-only reconciliation, scoped withdrawal and races, retained data, shared and
scheduled work, fixed storage/input limits and bounded/uncertain errors. Twenty-seven
synthetic lifecycle traces and independent invariant mutation tests add definition
evidence. The new semantic validator accepts lawful variation; it still cannot
verify context/provenance or measure backend effects.

The accepted v1 inventory and host pins above remain historical. The shared
website-management source has a capability-gated extension with a separate
1.1.0 skill lock; hosts require deliberate reviewed repinning. Backend/MCP PR45 is delivered and merged separately under literal #34 as
`48485a55773b1ca97e165a4715d343704270266e` (reviewed head
`edd55b83059122fbb3d83781be7e567e1680bbc9`); coordinator postchecks are pending.
It was not silently deferred to host rollout. That merge does not itself prove
contract or host acceptance. Definition tests do not establish
backend acceptance or production activation. Keep the provider checklist open
until exact-head backend/MCP tests and review evidence satisfy it. Host release
gates, unrelated backend issues and the coordinator's issue-closure ownership
remain as stated above.
