# Inbox-only Forms pilot UI

The pilot UI is a separately gated presentation, not a database authorization or activation. `rolloutFormsPilot` is false by default; the server-side `formsPilotEnabled` is also false and the private `formsPilotWebsiteId`/`formsPilotOwnerId` bindings are empty. The browser receives no configured binding: it asks the server about the current website, and the server verifies the bearer through the existing dashboard-auth helper, requires the configured owner/site pair and confirms ownership through the normal authenticated website API. Eligibility failures are closed and not cached. Never put real IDs, credentials or user-editable claims in source or public runtime configuration. The database owner/site gate remains authoritative for all direct RPCs, and an eligibility result is not a grant.

When pilot mode is selected, it takes precedence over the legacy `rolloutForms` UI flag and shows only an eligible site's host challenge and verification, form create/edit and existing owner inbox/export. Its setup uses the independently planned `begin_form_host_verification`, `form_host_challenge` (through the authenticated verifier) and `save_website_form` paths. No grant is made here. The pilot does not display or invoke status changes, response deletion, recipient management or delivery retry; it does not query recipient/job tables. Confirmation UI and its server endpoint are unavailable in pilot mode. When pilot mode is off, the existing legacy flag and behavior remain unchanged.

The private UI binding is a separate configuration from the API rollout flag, the DB approval gate and any worker rollout; all remain off/empty until separately reviewed and explicitly authorized. Before activation, integration must recheck the exact authenticated owner/site, any duplicate domain, ownership API, DB approval/grants and `form-verify` gateway policy, Fly trusted ingress, DNS operator and current source deployment. UI eligibility must not be treated as evidence that the database gate or service routes are safe. No notifications, mail, scheduler, DNS, secrets or live flags are enabled by this change. Owner deletion/emergency cleanup and same-ID reconciliation while the gate is revoked remain separate unresolved release requirements.

## Static dashboard build: owner inbox reads

The static build (`HTP_WEB_BUILD_TARGET=static`, `NUXT_PUBLIC_STATIC_DASHBOARD=true`) has no Nitro server, so the browser calls the HTP API origin directly with the caller's bearer. The default Nitro/SSR build is unchanged and keeps its same-origin `/api/forms/pilot-eligibility` check and direct Supabase reads.

- Pilot eligibility in static builds is `GET /websites/{id}/forms/pilot-eligibility`, which returns `{"eligible": bool}`. Any non-200, a missing boolean, or a thrown error fails closed. This is not a grant, and it is not a configured pilot binding (the static build has no private runtime config).
- When the static pilot is eligible, the forms list and the response list (and CSV export) come from `GET /websites/{id}/forms` and `GET /websites/{id}/forms/{form_id}/responses`, paged with `limit=100` and `offset`. Responses are not read from `website_form_responses` in the browser.
- Static pilot owner workflow (`apps/web/shared/utils/forms-owner-client.ts`, closed route allowlist, caller bearer only). No Supabase table, RPC or Edge Function runs on this path:
  - hosts: `GET /websites/{id}/forms/hosts` (paged)
  - edit form host selection: `GET /websites/{id}/forms/origins?form_id=` (paged)
  - DNS begin: `POST /websites/{id}/forms/host-verifications` body `{"hostname"}`
  - DNS confirm: `POST /forms/host-verifications/{host_id}/confirm` body `{"token"}`; the token is the 64-hex value from the begin `txt_value`
  - form save: `POST /websites/{id}/forms`; absent `form_id` creates, present `form_id` updates
- Outcome handling: only the documented codes are definite refusals. Transport errors, timeouts, 5xx, unlisted codes and a success body that does not match the request are unknown. After an unknown confirm, the host list is reloaded and Verify stays disabled until the page is reloaded; an unknown create or update disables Save and is not retried.
- Recipient, delivery-job, status, delete and retry paths are not shown in pilot mode and make no browser or API call.
- `rolloutFormsPilot` stays false by default. Nothing in this change sets it or any binding.

### Required API CORS (not part of this client change)

The dashboard CORS allowlist currently covers only `/websites` and `/websites/{id}`. A static browser origin needs exact-origin GET, POST and OPTIONS (`Authorization` and `Content-Type` request headers) on:

- `/websites/{id}/forms` (GET and POST)
- `/websites/{id}/forms/{form_id}/responses`
- `/websites/{id}/forms/pilot-eligibility`, `/hosts`, `/origins` (GET)
- `/websites/{id}/forms/host-verifications` (POST)
- `/forms/host-verifications/{host_id}/confirm` (POST, outside `/websites`)

This CORS change is a separate API change and is not made here. Until it lands, the static pilot path cannot run from a browser.

### Missing for actual activation

- Merged API routes for eligibility, hosts, origins, save, and DNS begin/confirm (PR 100 and PR 101 must land first).
- Activation still requires the DB gate, the owner/site pilot binding, the ownership API and the release checks already listed above.
