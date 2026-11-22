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
| Independent comparisons | `NUXT_PUBLIC_ROLLOUT_COMPARISONS=true` | — | Direct page shows unavailable and performs no RPCs. Database ACLs govern direct clients. |
| Indexed lifecycle history | `NUXT_PUBLIC_ROLLOUT_LIFECYCLE=true` | `HTP_ROLLOUT_LIFECYCLE=true` | Indexed history controls and endpoints unavailable; existing audit reads and local comparisons remain. |

For paired web/API controls, enable API first only after its dependencies are
ready, then web; hold web first when disabling. A mismatch fails closed at the
remaining disabled layer. These settings are not secrets and do not establish
website ownership. Never enable Forms ingress without separately verified trusted
proxy identity and its required service and IP-hash configuration.
