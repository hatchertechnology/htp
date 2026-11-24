# Owner Forms create/update REST API

Status: flag-gated, pilot-scoped, inbox-only pilot. Default off. Not an activation: no grants, migrations, deploys or live flags are changed by this document.

## Enablement (fails closed)

All three must be set, or the route returns 404 `forms_owner_save_disabled` with no upstream call:

- `HTP_FORMS_OWNER_SAVE_API=true` (only the exact value `true` enables). This is a separate flag from the inbox read flag `HTP_FORMS_OWNER_INBOX_API`, so the two rollouts stay independent.
- `HTP_FORMS_PILOT_WEBSITE_ID`: the pilot website UUID (shared with the inbox API and the dashboard `formsPilotWebsiteId`)
- `HTP_FORMS_PILOT_OWNER_ID`: the pilot owner UUID (shared with the inbox API and the dashboard `formsPilotOwnerId`)

A missing or malformed pilot UUID disables the route.

## Route

`POST /websites/{id}/forms` behind `auth::require_user`.

Body (JSON; unknown fields are refused):

| Field | Required | Meaning |
|---|---|---|
| `form_id` | no | Absent creates a form. Present updates that form. |
| `form_key` | yes | Stable key, `^[a-z][a-z0-9_]{0,63}$` |
| `name` | yes | Form name (the RPC trims it and allows 1 to 100 characters) |
| `fields` | yes | Array of 1 to 32 field definitions (`key`, `label`, `kind`, `required`, `max_length`) |
| `active` | yes | Boolean |
| `host_ids` | no | Up to 16 verified host UUIDs (default empty) |

Success returns 200 with `{id, form_key, name, fields, active}`. It is not a 201 and does not echo other row columns.

## Scope and behaviour

- Only the pilot website, and only for the pilot owner. Any other website or caller gets 404 `not_found` with no upstream call.
- The save runs as the caller: the caller's bearer is forwarded with the publishable key to the existing `save_website_form` RPC. No privileged key is used. Ownership, pilot approval, grants, field rules and host verification stay in the database.
- Local checks only mirror the RPC shape caps (key pattern, field count, host count). Field content and name rules are left to the RPC.
- The request body uses axum's default body limit, the same as the other authenticated JSON routes. The RPC's field and host caps are enforced as above.
- Every response carries `Cache-Control: no-store`, including malformed-input 400s and disabled 404s.

## Errors

| Code | Status | Meaning |
|---|---|---|
| `forms_owner_save_disabled` | 404 | Flag off or pilot pair missing. No upstream call. |
| `not_found` | 404 | Not the pilot website or owner, or the RPC refused the website or form as not found. |
| `unauthorized` | 401 | Caller identity or bearer missing or rejected. |
| `invalid_request` | 400 | Malformed JSON, unknown field, bad ID, key, field count or host count, or a database validation refusal. |
| `save_unknown_outcome` | 503 | The write may have committed. See below. |

Upstream message text is never copied into the response.

## Ambiguous outcomes

A transport error, timeout, 5xx, any non-200 success status, a success body that does not match the request, or a body read failure after a 2xx is `save_unknown_outcome`. The write may have committed.

- **Create** (`form_id` absent): the message says a form may already exist. Do not blindly retry the create. List the website's forms through `GET /websites/{id}/forms` (inbox API, same pilot gate) to reconcile first. The RPC has no idempotency key, so a retry can create a duplicate.
- **Update** (`form_id` present): reread the form before retrying. Do not assume it was or was not saved.

Only these are definite refusals and are reported as failed saves: 401, 403, 404, and a 400 raised by the database (`Invalid form`, `Invalid field definition`, `Active form needs a verified host`, `Invalid hosts`, `Host not found or not verified`, `Website not found`, `Form not found`). A database raise rolls back, so it does not write.

## Boundaries

- No recipient, delete, status, retry or hosted-call behaviour is added here. Only create and update.
- Redirects are disabled, so the bearer is never sent to another origin.
- The route and its tests run against a local `PostgREST` stand-in. Live verification of the RPC behaviour, grants and pilot approval is a separate step and is not claimed here.
