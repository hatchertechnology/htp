# Owner Forms inbox read API

Status: flag-gated, pilot-scoped, read-only. Default off.

## Enablement (fails closed)

All three must be set, or every route returns 404 `forms_inbox_disabled` with no upstream call:

- `HTP_FORMS_OWNER_INBOX_API=true` (only the exact value `true` enables)
- `HTP_FORMS_PILOT_WEBSITE_ID`: the pilot website UUID (same value as the dashboard `formsPilotWebsiteId`)
- `HTP_FORMS_PILOT_OWNER_ID`: the pilot owner UUID (same value as the dashboard `formsPilotOwnerId`)

A missing or malformed pilot UUID disables the routes.

## Scope

- Only the pilot website, and only for the pilot owner. Any other website or caller gets 404 `not_found` with no upstream call.
- Reads run as the caller: the caller's bearer is forwarded with the publishable key. No privileged key. Owner RLS still decides visibility.
- Routes (GET only, behind `auth::require_user`): `/websites/{id}/forms`, `/websites/{id}/forms/{form_id}/responses`, `/websites/{id}/forms/{form_id}/responses/{response_id}`.
- `limit` 1 to 100 (default 50); `offset` defaults to 0. List responses include `has_more`.
- Every response carries `Cache-Control: no-store`, including malformed-input 400s and disabled 404s.

## Pilot metadata (static WebsiteForms)

Read-only, same gate, same caller bearer, same pilot pair. Added for the static build, which has no Nitro server and so cannot read the private pilot binding. Each route is GET behind `auth::require_user`.

| Route | Body | Notes |
|---|---|---|
| `/websites/{id}/forms/pilot-eligibility` | `{"eligible": bool}` | `true` only for the exact pilot website and owner, and only when owner RLS on `websites` also returns the site to the bearer. Any other website or caller is `false` with no upstream call. |
| `/websites/{id}/forms/hosts` | `{"items": [{id, hostname, verified_at}], "has_more": bool}` | Ordered by `hostname,id`. Projection is `id,hostname,verified_at` only. `challenge_hash` is never selected and is also dropped by an allowlist on every row. |
| `/websites/{id}/forms/origins` | `{"items": [{form_id, host_id}], "has_more": bool}` | Ordered by `form_id,host_id`. Optional `form_id` filter (UUID; other values are 400). |

- Paging is the same as the other lists: `limit` 1 to 100 (default 50), `offset` default 0, `has_more` from one probe row.
- Non-pilot website or caller on hosts/origins: 404 `not_found`, no upstream call. Disabled gate: 404 `forms_inbox_disabled`. Missing caller: 401. Malformed input: 400 `invalid_request`. All carry `no-store`.
- Eligibility is a UI gate, not a grant. Database grants, owner RLS and the `forms_pilot_approved_sites` gate still decide every write and every row read.
- Responses never include the pilot IDs, the bearer, the publishable key, challenge hashes or any private runtime binding.
- Not covered here: CORS for a static browser origin. `dashboard_cors.rs` allowlists only the `/websites` paths, so the static build cannot call these routes from a browser until that allowlist is extended in its own reviewed change.
- The static build still reads `website_form_hosts`/`website_form_origins` directly until the static client moves to these routes; that client change is separate.
