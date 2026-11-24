# Forms owner domain verification: authenticated REST and MCP

Scope: the Forms DNS verification begin and confirm steps only. Other Forms operations are out of scope here and belong to the separate parity inventory.

## Entry points

Both run as the signed-in owner. The caller's bearer is forwarded with the publishable key to the existing scoped `begin_form_host_verification` RPC and the existing `form-verify` Edge Function. No privileged key is used. Ownership, the pilot-site approval, grants, hash and expiry checks, and quota all stay in the database and the function.

| Step | REST | MCP tool |
|---|---|---|
| Begin: create a DNS challenge | `POST /websites/{website_id}/forms/host-verifications` body `{"hostname":"www.example.com"}` | `begin_form_host_verification` |
| Confirm: check the published TXT | `POST /forms/host-verifications/{host_id}/confirm` body `{"token":"<64 hex>"}` | `confirm_form_host_verification` |

- REST sits behind the same `auth::require_user` layer as the websites routes.
- MCP tools are registered only when the server flag is on, so the default tool listing is unchanged.
- Responses are `Cache-Control: no-store`, because begin returns the challenge token once.

## Gate

`HTP_FORMS_VERIFICATION_MCP=true` enables both entry points. Any other value, or unset, fails closed. Disabled REST returns 404 and never calls upstream. Disabled MCP tools are unregistered and absent from the listing.

The database grants are still the authority. If `begin_form_host_verification` or `form_host_challenge` is not granted to `authenticated` for the site, the call fails as not found. The server flag cannot grant access.

## Results and codes

Success for begin returns `host_id`, `hostname`, `txt_name`, `txt_value` (`htp-verification=<token>`), and `expires_in_hours`. Publish the TXT record exactly, then confirm with `host_id` and the token.

Stable codes (fixed text, never upstream detail):

| Code | REST status | Meaning |
|---|---|---|
| `forms_verification_disabled` | 404 | Flag off |
| `website_not_found`, `host_not_found` | 404 | Not owned, not approved, or not found |
| `unauthorized` | 401 | Bearer missing or rejected |
| `invalid_request` | 400 | Bad ID, hostname, or token |
| `rate_limited` | 429 | Database challenge rate limit |
| `host_limit` | 409 | Site or account hostname limit |
| `dns_record_not_verified` | 422 | TXT missing or different |
| `challenge_expired_or_changed` | 409 | Challenge expired or replaced |
| `verification_unavailable` | 503 | Failed, retry later |
| `verification_unknown_outcome` | 503 | Outcome unknown |

On `verification_unknown_outcome`, do not assume success or failure, and do not publish or assume a new value. Reconcile the site's verification state before any further action. Retrying confirm for the same challenge is not documented as safe here, because the same-token retry behaviour is not proven against both contracts.

## Boundaries

- The challenge token is returned only to the authorized caller and is never logged. Error values never contain it.
- Redirects are disabled, so the bearer is never sent to another origin.
- Only the exact hostname is accepted. No wildcard, scheme, path, port, trailing dot, or uppercase.
- The `form-verify` Deno tests (`supabase/functions/form-verify/index_test.ts`) were run with Deno 2.9.7. The Edge Function itself is unchanged.
- The begin RPC replaces the challenge for an existing hostname in the current migration chain. The scoped procedure under review is stated to preserve an existing active or verified proof. Owners should not begin again while a previous verification is in flight until that is confirmed.
