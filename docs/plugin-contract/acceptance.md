# HTP #34 Wave 0 acceptance evidence

The accepted source baseline is PR #36, merge
`3db3e439ec0adc99211d49358a7cb8a29507a940`. This document reconciles
contract-definition completion with separately gated runtime delivery. The
coordinator owns issue closure and release decisions.

| Issue acceptance area | Evidence and scope |
| --- | --- |
| Shared reuse and ownership | README ownership section, `v1/skills.lock.json`; SEOsmith owns adapter semantics and future skills under SEOsmith #18. |
| OAuth and credential boundary | README authorization policy and host descriptors; no executed login claimed. |
| Host transports | Versioned host descriptors cite official sources and observed versions; minimum supported versions remain unknown. |
| Scheduling and private scope | README requires HTP #7 authorization and configured private execution with explicit scope. |
| Reads, identity, bounds and cancellation | Inventory and fixtures define effects and target semantics. Saved reads create no collection jobs. Provider report requests register collection and have no plugin-level durable identity guarantee. This is a disclosed backend exception, not runtime acceptance. |
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
`e9efb57`; Pi final-pin review remains pending at this assessment. Neither is
proof of a shipped host package.

For #34 bookkeeping, the coordinator should reconcile the checklist against these
contract-level qualifications, explicitly retain the provider identity exception,
and record the reviewed documentation commit and validation results before closure.
No missing Wave 0 runtime feature is established here; runtime release gates must
not be reported as completed by this contract assessment.
