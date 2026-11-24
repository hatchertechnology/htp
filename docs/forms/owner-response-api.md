# Owner Forms response management REST API

Default off, API only. UI behavior and all database grants, migrations and gates remain unchanged.

Enablement requires the exact setting `HTP_FORMS_OWNER_RESPONSE_API=true` plus valid `HTP_FORMS_PILOT_WEBSITE_ID` and `HTP_FORMS_PILOT_OWNER_ID` UUIDs, read once at startup. This flag is independent of inbox reads, form saves and verification. Missing or malformed pilot bindings disable these operations. Enabling this API does not enable its UI or grant database execution rights.

Both routes run behind the existing `auth::require_user` verifier. Only the configured pilot owner and website can proceed; a different owner/site gets 404 `not_found` before any upstream call. The original verified caller bearer and existing publishable key are forwarded. There is no privileged credential or generic RPC endpoint.

| Operation | Route | Body | 200 result |
|---|---|---|---|
| Change status | `PATCH /websites/{id}/forms/{form_id}/responses/{response_id}/status` | `{"status":"new"}`, `{"status":"reviewed"}` or `{"status":"spam"}` only | `{"id":"<response UUID>","status":"reviewed"}` |
| Explicit deletion | `DELETE /websites/{id}/forms/{form_id}/responses/{response_id}` | Empty; nonempty bodies are refused | `{"id":"<response UUID>","deleted":true}` |

All path IDs must be UUIDs. Unknown status-body fields, missing status and other status values are rejected. Responses carry `Cache-Control: no-store`. The usual authenticated JSON/body size limit applies. Status success validates the returned row's response, website and form IDs and requested status, then returns only management metadata. Delete success requires the RPC's exact JSON boolean `true`.

The inspected RPC contracts are:

- `set_website_form_response_status(p_website_id uuid, p_form_id uuid, p_response_id uuid, p_status text) returns jsonb`, defined in `20261122000300_forms_management.sql` and replaced in `20261201000000_forms_pilot_scope.sql`.
- `delete_website_form_response(p_website_id uuid, p_form_id uuid, p_response_id uuid) returns boolean`, defined in `20261122000500_forms_response_deletion.sql` and replaced in the same pilot migration.

Both retain authenticated non-anonymous ownership and exact row scope; the pilot definitions additionally require `forms_pilot_site_allowed`. The pilot migration revokes owner RPC execution by default. Deletion retains database locks, the in-flight notification refusal (`55000`), submission digest tombstone and notification-history deletion. This API does not bypass any of those requirements and does not prove hosted availability.

| Error code | HTTP | Meaning |
|---|---|---|
| `forms_owner_response_disabled` | 404 | Flag off or missing pilot binding; never sent upstream |
| `not_found` | 404 | Wrong pilot site/owner, or upstream 403/404 refusal |
| `unauthorized` | 401 | Missing/rejected caller authorization |
| `invalid_request` | 400 | Local malformed input or database `22023` refusal |
| `response_notification_sending` | 409 | Delete refused by database `55000` (PostgREST HTTP 500); nothing deleted |
| `response_status_unknown_outcome` | 503 | Status may or may not have changed |
| `response_delete_unknown_outcome` | 503 | Response may or may not have been deleted |

Upstream text is never echoed. Transport failures, timeouts, body-read failures, malformed/mismatched success, unexpected success status, redirects and unrecognized errors are ambiguous. No automatic retries or redirects occur; the deadline is 10 seconds. Reread the response/inbox before another explicit attempt. An absent response after an ambiguous delete is a reconciliation observation, not proof that this particular request deleted it. Existing inbox reads need their own flag and database permission.

CORS uses the existing single exact configured dashboard origin, authorization/content-type headers only, and no credentials. The response detail path allows existing GET plus DELETE; the exact `/status` path allows PATCH only. No collection writes, bulk deletes, retry routes or sibling paths are added.

Validation uses synthetic local HTTP stand-ins only. No live submissions, deletion, hosted calls, grant changes or deployments are part of this work.
