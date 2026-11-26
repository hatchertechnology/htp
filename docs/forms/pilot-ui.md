# Dashboard Forms page (pilot UI)

The Forms page (`apps/web/app/pages/forms/index.vue`, component `WebsiteForms.vue`) is a separately gated presentation, not a database authorization or activation. Which surface it shows comes from `formsSurface()` (`apps/web/shared/utils/forms-availability.ts`): `rolloutFormsPilot=true` selects the **pilot** mode and wins over the legacy flag; otherwise `rolloutForms=true` selects the **legacy** mode; with both false the page still renders its "Forms" heading and generic description plus "Forms are not available in this workspace yet"; no Forms data or controls render. Both flags default false (`apps/web/nuxt.config.ts`).

## Pilot eligibility (fails closed)

Pilot mode never renders until an eligibility read resolves for the selected website:

- **Nitro/SSR builds** ask the same-origin server route `GET /api/forms/pilot-eligibility?website_id=…` (`apps/web/server/utils/forms-pilot.ts`). The server checks `rolloutFormsPilot` and the private `formsPilotEnabled`/`formsPilotWebsiteId`/`formsPilotOwnerId` bindings, verifies the bearer through the existing dashboard-auth helper, requires the configured owner/site pair, and confirms ownership through the normal authenticated website API. Eligibility failures are closed and not cached.
- **Static builds** (`HTP_WEB_BUILD_TARGET=static`, `NUXT_PUBLIC_STATIC_DASHBOARD=true`) have no Nitro server, so the browser calls the HTP API directly with the caller's bearer: `GET /websites/{id}/forms/pilot-eligibility`, which returns `{"eligible": bool}`. Any non-200, a missing boolean, or a thrown error fails closed. The private bindings never reach the browser.
- An eligibility result is a UI gate, **not a grant**. The database owner/site gate remains authoritative for all direct RPCs, and API routes remain separately flag-gated.

While pilot eligibility is unresolved the Forms section renders nothing; a resolved negative shows "Forms aren't enabled for <fqdn>. The Forms pilot is limited to approved websites." When pilot mode is off, the existing legacy flag and behavior remain unchanged.

## Reads and writes

- **Static pilot builds** read forms and responses through the authenticated owner inbox API (`apps/web/shared/utils/forms-inbox-client.ts`): `GET /websites/{id}/forms` and `GET /websites/{id}/forms/{form_id}/responses`, paged with `limit=100` and `offset`. Responses are never read from `website_form_responses` in the browser. Hosts, form-origin selection, DNS begin/confirm and form saves go through the closed owner-route allowlist (`apps/web/shared/utils/forms-owner-client.ts`, caller bearer only; no Supabase table, RPC or Edge Function runs on this path).
- **Legacy and non-static pilot builds** keep the existing direct Supabase RLS reads and RPC writes (`begin_form_host_verification`, `save_website_form`, `set_website_form_response_status`, `delete_website_form_response`, recipient RPCs).
- Outcome handling: only the documented codes are definite refusals. Transport errors, timeouts, 5xx, unlisted codes and a success body that does not match the request are unknown. After an unknown DNS confirm, Verify stays disabled until the host list reload shows the state; an unknown create or update disables Save and is not retried until the owner reloads and reconciles.

## Page layout

With a selected website the page shows a form selector (each form's name plus its Active/Paused state) and two tabs, **Responses** and **Setup**.

### Responses tab

`FormsSubmissionsTable.vue` renders the selected form's responses with:

- **Columns**: the form's fields in declared order, then any extra value keys sorted by key (`submissionColumns`); labels for extra keys are the keys.
- **Status**: each row carries `new`, `reviewed` or `spam`.
- **Client-side table controls** over the loaded rows: status filter checkboxes (at least one stays selected), a received-from/received-to date range in the viewer's local timezone, and a case-insensitive NFKC substring search across values. Sorting toggles between Received, Status and any field column; empty field values sort last. When filters hide rows the table shows "Showing X of Y loaded". Sorting, filters and search apply only to the loaded rows; when more pages exist the table says so, and "Load next 100" appends the next page.
- **Row actions**: View (all values), per-row Mark reviewed / Mark spam / Delete with an explicit confirmation ("Permanently delete this response and its notification history?"), and Mark new in static pilot builds only.
- **Bulk status**: selecting rows (including rows across loaded pages) enables Mark reviewed / Mark spam / Mark new. Bulk status is status only — it acts on every selected loaded row, stops on the first refusal or unknown outcome, and reports succeeded, failed, unknown and not-attempted counts. In **static pilot builds** each row is one owner API call with no intermediate reload, and the pass ends with one inbox reload only when at least one row changed and no outcome was unknown; a pass refused on its first row changes nothing, so it does not reload. **Legacy builds** call the per-row status RPC instead, and every row that changes performs its own full inbox reload, so a legacy bulk pass reloads once per changed row and each reload resets the table to the bounded first page.
- **Management availability**: status and delete are offered in legacy non-static builds (direct RPCs) and in static pilot builds only when `rolloutFormsResponses=true` routes them through the owner response API (`PATCH …/responses/{id}/status`, `DELETE …/responses/{id}`; see [owner-response-api](owner-response-api.md)). Pilot mode on a Nitro/SSR build offers no response management. An unknown outcome locks the controls until the inbox reloads.
- **CSV export**: "Export all responses (CSV)" downloads `<form_key>.csv` containing every response for the form, not only the loaded or filtered rows. Columns are `received_at`, `status`, then the same key set as the table: declared field keys in declared order, then any extra keys in first-seen order (the table sorts extra keys, so that part of the order can differ). Times are UTC and filters are not applied. Values are quoted with `""` escaping, and a leading apostrophe (`'`) is inserted before any cell whose text starts (after whitespace/control characters) with `=`, `+`, `@` or `-` to neutralize spreadsheet formula injection (`apps/web/app/utils/forms-csv.ts`).

### Setup tab

- **Verify a website host**: create a DNS challenge for a hostname, publish the TXT record, and verify it. The challenge expires after 24 hours; a new challenge invalidates the old proof. Hosts and their verification state are listed below.
- **Create or edit a form**: form name, form key (`[a-z][a-z0-9_]{0,63}`), field rows (key, label, type `text`/`email`/`telephone`/`multiline`, maximum characters 1–5000, a Required checkbox), 1–32 fields, and the permitted verified hosts. "Accept submissions" toggles the active flag; an active form requires at least one verified host. Each form's submission endpoint is shown as `<apiBaseUrl>/public/forms/<form id>`.
- **Field flags**: each field declares `required` and `max_length`. The pilot form's flags are decided by owner decision D4 (2026-11-26): **name, email and message required; phone optional**, applied through `save_website_form` with the same keys and limits. The production form configuration is confirmed by the R4/batch-3 checks, not by this document. Required fields reject empty values at ingress with `validation_failed` and `fields`; see [contract](contract.md).

### Notifications

**Notifications are implemented but not configured for the pilot** (owner decision D3, 2026-11-26): the intended pilot state is inbox-only, with zero recipients, no delivery schedule and no delivery credentials, and the production state is confirmed by the R4/batch-3 checks, not by this document. The UI has two notification surfaces:

- **Legacy non-static builds** show notification recipients and per-response delivery jobs read directly from Supabase, with add-recipient, disable and retry controls. A retry of an `uncertain` job requires confirming that the provider may already have delivered the message.
- **Static pilot builds** show the separate `FormsNotifications.vue` panel only when the eligibility read reported `notifications_available`, the build is static, and `rolloutFormsNotifications=true`; it reads recipients and delivery jobs through the owner notification API and offers request-verification, disable and retry. Queue acceptance does not confirm verification or delivery, and "sent" records provider acceptance, not inbox arrival.

Neither surface implies that delivery is configured; see [contract](contract.md) for the production state and the worker requirements.

## Required API CORS

The dashboard CORS allowlist (`apps/api/src/dashboard_cors.rs`) covers the exact forms routes the static pilot needs: `/websites/{id}/forms` (GET, POST), `/websites/{id}/forms/{form_id}/responses` (GET) and `/responses/{id}` (GET, DELETE), `/responses/{id}/status` (PATCH), `/forms/pilot-eligibility`, `/forms/hosts`, `/forms/origins` (GET), `/forms/host-verifications` (POST), `/forms/host-verifications/{host_id}/confirm` (POST), and the notification collection routes (recipients GET/POST with disable, delivery-jobs GET with retry). Methods and paths outside this allowlist are refused. This is a separate API concern from the page itself; the static build cannot run from a browser where the allowlist is not deployed.

## Activation boundaries

The private UI binding is a separate configuration from the API rollout flag, the DB approval gate and any worker rollout; all remain off/empty until separately reviewed and explicitly authorized. UI eligibility must not be treated as evidence that the database gate or service routes are safe. No notifications, mail, scheduler, DNS, secrets or live flags are enabled by UI changes. Owner deletion/emergency cleanup and same-ID reconciliation while the gate is revoked remain separate unresolved release requirements.
