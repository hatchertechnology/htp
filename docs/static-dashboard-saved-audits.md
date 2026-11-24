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

Static run detail is bounded in the browser by time, not size: the whole read (headers and body) has the same
120 s deadline as the bounded server proxy, and an abort (run change, unmount, or deadline) cancels the fetch and the body read.
Timeouts, aborts and malformed JSON all surface as "Seosmith reports could not load. Try again.". The browser applies no byte cap,
matching the default proxy.

Size boundary (server side, the only size limits that exist):

- Import input: `report_json` is refused above 4,952,756 UTF-8 bytes (`supabase/migrations/20261121120000_seosmith_input_cap.sql`,
  and `apps/api/src/seosmith.rs` `import`/`ingest`). Rows written before that migration were accepted up to 16,777,216 bytes
  (earlier migrations, for example `20261116210550_seosmith_versioned_receiver.sql`), so legacy rows can hold raw reports above
  4,952,756 bytes.
- Detail body: the detail function returns both the parsed `report` (jsonb) and the raw `report_json`, so the body is larger than
  the raw report. It is not bounded by the import limit: JSON escaping roughly doubles quoted text, and jsonb text output can differ
  in length from the stored raw bytes. No server-side cap is applied to the detail response.
- The static client therefore has no byte cap of its own. A browser-side cap would refuse normal stored runs, as PR 95's review
  showed for runs near the import limit.

The default bounded `/dashboard` proxy keeps its server-side 120 s deadline.

The API returns the stored detail body without a size cap (see the size boundary above). The list `limit` is not clamped server-side either; the
static client always sends `limit=50`. Both are API-side follow-ups and are not changed here.

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
