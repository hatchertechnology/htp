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
