# Static gated evidence transport

No rollout settings or defaults change. Static dashboard requests use the owner bearer and the configured API origin only when their existing public UI flag is exactly `true`. API rollout capabilities remain authoritative. Nitro retains its existing gates for legacy clients.

## Contract audit (before implementation)

All requested routes are already gated in `apps/api/src/lib.rs::rollout_gate`, mounted on the protected router outside its handlers and inside user authentication. The gate matches the exact path segment counts below; disabled capabilities return 503 before storage or provider access. `RolloutCapabilities::from_env` requires literal `true`; defaults are false.

| Owner REST path under `/websites/{UUID}` | Method | Public flag / authoritative environment gate | Nitro contract / Rust contract |
| --- | --- | --- | --- |
| `/search/dataset` | POST | rolloutSearchEvidence / HTP_ROLLOUT_SEARCH_EVIDENCE | `server/utils/search.ts::proxySearch` forwards body unchanged to `search.rs::dataset` |
| `/search/crawl-evidence` | POST | rolloutSearchEvidence / HTP_ROLLOUT_SEARCH_EVIDENCE | Same proxy forwards body unchanged to `search.rs::crawl_evidence` |
| `/seo/audits/lifecycle` | GET | rolloutLifecycle / HTP_ROLLOUT_LIFECYCLE | `server/utils/seosmith.ts::proxySeosmith` projects entity_id, rule, limit (default 50), before, before_id; `seosmith.rs::LifecycleQuery` accepts the same fields and default |
| `/seo/audits/url-lifecycle` | GET | rolloutLifecycle / HTP_ROLLOUT_LIFECYCLE | Same proxy omits rule; `UrlLifecycleQuery` matches |
| `/seo/audits/{UUID}/work` | GET | rolloutRemediation / HTP_ROLLOUT_REMEDIATION | `server/utils/seosmith-work.ts::proxySeosmithWork` projects finding_index, before, before_id; `WorkQuery` matches |
| `/seo/audits/{UUID}/work` | POST | rolloutRemediation / HTP_ROLLOUT_REMEDIATION | Same proxy forwards body unchanged; Rust `WorkInput` accepts finding_index and work |
| `/seo/work/{UUID}/attempts` | POST | rolloutRemediation / HTP_ROLLOUT_REMEDIATION | Same proxy forwards body unchanged; Rust `AttemptInput` accepts delivery_id, result, note |

Search requires no Google access token for these saved evidence actions (the Nitro proxy obtains one only for inspect). Each proxy forwards owner Authorization, API response status and parsed JSON unchanged; there is no response projection to reproduce. Seosmith responses already use no-store. Search timeout is 35 seconds and Seosmith timeout is 30 seconds; static requests preserve those deadlines, disable retry, and reject redirects. Read query projection is preserved to avoid sending extra fields into Rust's deny_unknown_fields lifecycle queries.

No real parity mismatches were found in these seven operations, so none were skipped. Other routes (including bounded audit detail) are outside this change. Exact canonical-width UUID route shapes and implemented methods alone gain CORS; origin/header restrictions and opt-in CORS configuration remain unchanged. CORS availability never enables a server capability.

Validation uses synthetic browser fetch stubs and local Axum middleware requests only. No hosted services are called.
