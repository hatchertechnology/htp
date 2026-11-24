# Inbox-only Forms pilot UI

The pilot UI is a separately gated presentation, not a database authorization or activation. `rolloutFormsPilot` is false by default; the server-side `formsPilotEnabled` is also false and the private `formsPilotWebsiteId`/`formsPilotOwnerId` bindings are empty. The browser receives no configured binding: it asks the server about the current website, and the server verifies the bearer through the existing dashboard-auth helper, requires the configured owner/site pair and confirms ownership through the normal authenticated website API. Eligibility failures are closed and not cached. Never put real IDs, credentials or user-editable claims in source or public runtime configuration. The database owner/site gate remains authoritative for all direct RPCs, and an eligibility result is not a grant.

When pilot mode is selected, it takes precedence over the legacy `rolloutForms` UI flag and shows only an eligible site's host challenge and verification, form create/edit and existing owner inbox/export. Its setup uses the independently planned `begin_form_host_verification`, `form_host_challenge` (through the authenticated verifier) and `save_website_form` paths. No grant is made here. The pilot does not display or invoke status changes, response deletion, recipient management or delivery retry; it does not query recipient/job tables. Confirmation UI and its server endpoint are unavailable in pilot mode. When pilot mode is off, the existing legacy flag and behavior remain unchanged.

The private UI binding is a separate configuration from the API rollout flag, the DB approval gate and any worker rollout; all remain off/empty until separately reviewed and explicitly authorized. Before activation, integration must recheck the exact authenticated owner/site, any duplicate domain, ownership API, DB approval/grants and `form-verify` gateway policy, Fly trusted ingress, DNS operator and current source deployment. UI eligibility must not be treated as evidence that the database gate or service routes are safe. No notifications, mail, scheduler, DNS, secrets or live flags are enabled by this change. Owner deletion/emergency cleanup and same-ID reconciliation while the gate is revoked remain separate unresolved release requirements.

## Static dashboard build: owner inbox reads

The static build (`HTP_WEB_BUILD_TARGET=static`, `NUXT_PUBLIC_STATIC_DASHBOARD=true`) has no Nitro server, so the browser calls the HTP API origin directly with the caller's bearer. The default Nitro/SSR build is unchanged and keeps its same-origin `/api/forms/pilot-eligibility` check and direct Supabase reads.

- Pilot eligibility in static builds is a read of `GET /websites/{id}/forms?limit=1&offset=0`. The API's pilot affinity decides; any non-200 or non-list response fails closed. This is not a grant, and it is not a configured pilot binding (the static build has no private runtime config).
- When the static pilot is eligible, the forms list and the response list (and CSV export) come from `GET /websites/{id}/forms` and `GET /websites/{id}/forms/{form_id}/responses`, paged with `limit=100` and `offset`. Responses are not read from `website_form_responses` in the browser.
- Still browser database reads in static pilot mode (no API projection exists): `website_form_hosts` (host list), `website_form_origins` (edit form host selection) and the form/host write RPCs. Recipient, delivery-job, status, delete and retry paths are not shown in pilot mode.
- `rolloutFormsPilot` stays false by default. Nothing in this change sets it or any binding.

### Required API CORS (not part of this client change)

The dashboard CORS allowlist currently covers only `/websites` and `/websites/{id}`. A static browser origin needs exact-origin GET and OPTIONS (`Authorization` request header only) on:

- `/websites/{id}/forms`
- `/websites/{id}/forms/{form_id}/responses`

### Missing for actual activation

- An API eligibility read that returns only a boolean for the pilot pair (replacing the forms-list probe).
- An API read for `website_form_hosts` and `website_form_origins` so the static pilot does not query those tables from the browser.
- Activation still requires the DB gate, the owner/site pilot binding, the ownership API and the release checks already listed above.
