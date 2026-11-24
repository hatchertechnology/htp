# Static dashboard: saved Seosmith audit reads

The opt-in static dashboard (`npm run build:static`, `NUXT_PUBLIC_STATIC_DASHBOARD=true`) has no Nitro
server. Its saved audit history and run detail therefore call the HTP API origin directly, with the
owner's bearer token. The default Fly/SSR build is unchanged and keeps the same-origin `/api/...` proxy.

Client code: `apps/web/shared/utils/seosmith-client.ts` (routing) and `apps/web/app/composables/useSeosmith.ts`.

## Routed reads

| Dashboard path (proxy, default) | Static request | Notes |
| --- | --- | --- |
| `GET /api/websites/{site}/seo/audits?limit=50[&before=…&before_id=…]` | `GET {api}/websites/{site}/seo/audits?limit=50[&before=…&before_id=…]` | History list and cursor paging. |
| `GET /api/websites/{site}/seo/audits/{run}` | `GET {api}/websites/{site}/seo/audits/{run}` | Run detail. Validated in the browser: JSON media type, full body, and matching `delivery_id`. |

`{site}` and `{run}` must be lowercase or uppercase hyphenated UUIDs. Anything else is refused before a request is sent.

Not routed in static mode (their calls still use `/api/...` and will fail on the static host):
`/seo/audits/import`, `/seo/audits/lifecycle`, `/seo/audits/url-lifecycle`, `/seo/audits/{run}/work`,
`/seo/audits/{run}/dashboard`, and the comparison-detail and lifecycle fetches made directly by
`SeosmithDashboard.vue`. `useSeosmith().importFile` returns a local "not available" error in static mode.

## Additional API CORS requirements

The static origin is the browser origin for these calls, so the HTP API must answer them with CORS.
The API's current CORS handling is limited to the forms ingress (`apps/api/src/form_ingress.rs`); the Seosmith
read router (`apps/api/src/seosmith.rs`, `read_router`) has none. These are the additional paths:

- `GET /websites/{id}/seo/audits`
- `GET /websites/{id}/seo/audits/{run}`
- `OPTIONS` preflight for both paths above (no authentication on the preflight)

Required headers:

- Request, from the browser: `Authorization: Bearer <owner token>`. That is the only non-safelisted request header.
  `Accept: application/json` (sent by `$fetch`) is CORS-safelisted and needs no allowance.
- Preflight response: `Access-Control-Allow-Origin: <the exact static dashboard origin>`,
  `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Allow-Headers: Authorization`, `Vary: Origin`.
  An optional `Access-Control-Max-Age` may be set.
- Actual response: `Access-Control-Allow-Origin: <the exact static dashboard origin>` and `Vary: Origin`.
  Do not use `*`, and do not set `Access-Control-Allow-Credentials`: the dashboard sends no cookies.
- `Content-Type` stays `application/json`. The browser reads only CORS-safelisted response headers, and the
  dashboard checks `Content-Type` on the detail, so no `Access-Control-Expose-Headers` is needed.
- Keep `Cache-Control: no-store` on the existing responses.

The existing `/websites` paths used by the static dashboard's website list need the same allowance; this
document does not change that requirement.

No API code was changed in this work. Deployment of the CORS allowance is a separate, reviewed change.
