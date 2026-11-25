# Optional second Forms owner pilot (Rust Fly source)

The existing `HTP_FORMS_PILOT_WEBSITE_ID` and `HTP_FORMS_PILOT_OWNER_ID`
remain required. With no second-pair variables, behavior is unchanged.
The inbox, save and response feature flags still default off and require exact
`true`; this change sets no environment variables or deployment configuration.

To opt in later, explicitly supply both `HTP_FORMS_SECOND_PILOT_WEBSITE_ID` and
`HTP_FORMS_SECOND_PILOT_OWNER_ID` as UUIDs. Both pairs must be complete and valid.
Partial, empty, malformed or non-Unicode second configuration disables the
expanded owner routes and their MCP discovery, rather than falling back to the
first pair. A repeated website is rejected, including an identical repeated pair,
so one website cannot have ambiguous owners. One owner may explicitly pair with
two distinct websites. A second pair cannot replace a missing first pair.

Inbox lists/detail, host/origin metadata, eligibility, form save, response status
and deletion all require the requested website and verified caller ID to match
one complete pair before upstream access. Cross-pair combinations are denied;
owner IDs and website IDs are never treated as independent allowlists. REST and
MCP reuse the same authorization handlers. Eligibility reports false for a
nonmatching pair without upstream access; a matching pair still requires a
visible website under owner RLS. Existing authentication, user bearer forwarding,
publishable key, validation, projections, no-store responses, timeout/redirect
policy, uncertainty handling and no-retry behavior remain in place. Configuration
is an additional admission fence, not a database grant or ownership proof.

## Notification boundary

Owner notification operations intentionally read only the existing first pair
and retain their existing exact owner/site check, regardless of second-pair
configuration (including invalid second configuration). Their live catalog guards
support only one scoped website. Adding a second inbox/save/response pair does
not authorize its notification reads, recipient/confirmation operations, job
status/recovery or notification writes. Extending that boundary needs separate
review of the catalog fences and is outside this source-only change.

No migrations, grants, public ingress, dashboard/static client, provider settings,
default flags or live configuration change here. A second pair still needs
separately authorized database scope/approval and client configuration before any
live pilot can work; local synthetic tests do not prove hosted RLS or availability.

## Static notification capability

The authenticated Rust `GET /websites/{id}/forms/pilot-eligibility` response
preserves `eligible` for both configured pairs. It optionally adds
`notifications_available: true` only for the primary website/owner pair, with
`HTP_FORMS_OWNER_NOTIFICATION_API=true`, after the existing verified caller
match and caller-bearer site RLS visibility check. Otherwise the capability is
omitted. Errors and default-off behavior retain the existing contract.

The static Forms dashboard reuses this single eligibility request. Notification
controls require explicit boolean `true` plus the existing static pilot and
notification rollout switches. Missing capabilities from older APIs fail closed:
the panel stays hidden and makes no notification metadata requests. Identity,
anonymous status, site, or mode changes clear eligibility synchronously; late
answers cannot restore controls for an earlier context. Legacy and Nitro paths
retain their existing behavior.

This capability describes API route availability only. It does not promise
database admission, recipient verification, queue acceptance, or delivery. It
changes no notification authorization, SQL, hosted configuration, or default flags.
Local regressions: `cargo test -p htp-api --offline --lib form_inbox`,
`cargo test -p htp-api --offline --lib form_notifications`, and, with the local
Forms Vite fixture running, `node tests/fixtures/check-forms-static-notifications.mjs`.
