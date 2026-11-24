# Wave 1 rollout capabilities

These availability controls default off and do not grant access. Database ACLs,
RLS, application authentication, service credentials and ingress readiness remain
independent safeguards. Set flags only after the relevant migrations, narrow grants,
end-to-end checks and recovery plan are separately approved. Turning a flag off
hides the surface; it does not undo collected data or revoke database privileges.

| Capability | Web runtime variable | API runtime variable | Held behavior |
| --- | --- | --- | --- |
| Forms | `NUXT_PUBLIC_ROLLOUT_FORMS=true` | `HTP_ROLLOUT_FORMS=true` | Management and confirmation hidden; public ingress 503. Existing proxy trust, secrets and rate gates still apply. |
| Saved Search evidence | `NUXT_PUBLIC_ROLLOUT_SEARCH_EVIDENCE=true` | `HTP_ROLLOUT_SEARCH_EVIDENCE=true` (API and Google worker separately) | Dataset and crawl evidence unavailable; existing Search dashboard and inspection remain; the worker omits optional previous-period and segmented provider requests. |
| Independent comparisons | `NUXT_PUBLIC_ROLLOUT_COMPARISONS=true` (full workflow); `NUXT_PUBLIC_ROLLOUT_COMPARISONS_READ_ONLY=true` (read-only; wins if both) | — | Direct page shows unavailable and performs no RPCs. Database ACLs govern direct clients. Read mode loads retained evidence but hides import, save and removal controls. |
| Indexed lifecycle history | `NUXT_PUBLIC_ROLLOUT_LIFECYCLE=true` | `HTP_ROLLOUT_LIFECYCLE=true` | Indexed history controls and endpoints unavailable; existing audit reads and local comparisons remain. |

For paired web/API controls, enable API first only after its dependencies are
ready, then web; hold web first when disabling. A mismatch fails closed at the
remaining disabled layer. These settings are not secrets and do not establish
website ownership. Never enable Forms ingress without separately verified trusted
proxy identity and its required service and IP-hash configuration.

Before and after a separately authorized deployment, run the held and enabled
browser checks in an isolated application with synthetic authentication and
intercepted Supabase requests (`apps/web/tests/fixtures/check-rollout-held.mjs`,
`check-independent-audits.mjs` and `check-comparison-modes.mjs`, driven by
`HTP_COMPARISON_MODE=off|read-only|full|both`). The disposable native fixtures
`scripts/comparison-native/run.sh read` and `run.sh full` additionally exercise
real loopback PostgREST owner/nonowner reads, import, exact original download and
replay. Confirm held comparisons make no RPCs,
Forms controls are hidden, and enabled controls work with fixture data. These
checks are not currently in PR CI: the existing jobs run unit and Vite fixtures
but do not build or start the full Nuxt application; adding a second application
build solely for this check would duplicate that work. The local dev-server
fixture is not a deployed application or production authorization test.
