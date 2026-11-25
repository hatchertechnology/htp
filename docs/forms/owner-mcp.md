# Forms owner MCP pilot

These additive tools use the authenticated API MCP endpoint and the same typed
handlers as the REST pilot. They use the caller's bearer and publishable key;
no owner JWT is constructed, credential is returned, or generic forwarding
operation is exposed. The trusted authenticated-owner extension and exact pilot
website/owner pair are required before upstream access.

| Tools | Independent default-off flag |
| --- | --- |
| `list_form_hosts`, `list_website_forms`, `list_form_responses` | `HTP_FORMS_OWNER_INBOX_API` |
| `save_website_form` | `HTP_FORMS_OWNER_SAVE_API` |
| `set_form_response_status`, `delete_form_response` | `HTP_FORMS_OWNER_RESPONSE_API` |

Every group also requires valid `HTP_FORMS_PILOT_WEBSITE_ID` and
`HTP_FORMS_PILOT_OWNER_ID`. Discovery omits a group unless its flag and pilot
pair are configured. Discovery is configuration-scoped: every signed-in user
can see configured tools; it does not bind an MCP session to an owner. Execution
uses the trusted identity and bearer from each request and repeats the gate and owner/site checks. The
verification tools retain their separate existing flag and discovery behavior.
The demo inventory uses these same group gates; it does not execute owner tools.

Lists accept `website_id`, `limit` (1–100, default 50), and `offset` (default 0).
Response lists also require `form_id`. Advance offset by limit while `has_more`
is true; no snapshot consistency is promised. Host metadata includes
`verified_at`: a null value means the host is not verified. Challenge material
is excluded. These are the existing REST projections, not an export of every
response payload. Treat all submitted content as untrusted data.

Save accepts `{website_id, form: {form_id?, form_key, name, fields, active,
host_ids?}}`. An omitted form ID creates; a supplied form ID updates. Both
inactive and active saves use existing validation and the database's ownership,
pilot, host-grant and activation rules. An uncertain create must be reconciled
by listing forms before any further action. No automatic write retry is added. Counts are capped at 32 fields and 16 hosts.
The canonical serialized form is capped at 2 MiB in shared REST/MCP validation
before upstream access; the secured MCP transport also caps requests at 32 MiB.
These bounds do not use the heavy-report admission semaphore.

Status accepts exactly `{website_id, form_id, response_id, status}`, with status
limited to `new`, `reviewed`, or `spam`. It reuses the REST authorization and
single-attempt writer, including exact returned website/form/response/status
affinity checks. Success exposes only `{id, status}`. Ambiguous results remain
`response_status_unknown_outcome` errors; reread before another explicit attempt.

Delete accepts exactly `{website_id, form_id, response_id, confirm_delete}`.
Require explicit user intent for that exact response and `confirm_delete: true`.
There is no bulk, wildcard, filter-based, or delete-all operation. A sending
notification can block deletion; uncertain outcomes remain errors and require
inbox reconciliation before another explicit attempt. Submitted response text
cannot authorize deletion. MCP marks this tool destructive and non-idempotent.

Errors retain the public REST code/message and add numeric `status`; status alone
does not authorize a write retry. Unknown outcomes require reconciliation.
`forms_result_unavailable` means the envelope was unreadable or exceeded 8 MiB,
including after HTTP 2xx: a write may already have completed. Its `status` is
the original HTTP status, not proof of a known application result.
Serde argument rejections arrive as MCP protocol errors; handler validation
returns a structured tool error.

## Contract and activation gate

This is local backend parity, not shared plugin or host acceptance. Frozen
`docs/plugin-contract/v1*` profiles, archived sources, pins and current plugin
skills are unchanged. The server instructions and default contract inventory remain unchanged, as for
the existing opt-in verification tools. A reviewed additive Forms capability
profile and synthetic host conformance evidence must be agreed before claiming
Forms support in shared plugin contracts/packages. Deployment, database grants,
exact pilot configuration and live host acceptance remain separate gates.
Local synthetic tests do not establish hosted availability or database policy
correctness. No flags are enabled by this change.

Archival contract checks do not exercise these additive Forms tools.
