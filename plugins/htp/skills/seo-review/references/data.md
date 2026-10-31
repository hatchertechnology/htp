# HTP data and authentication reference

The remote server uses Streamable HTTP at
`https://htp-api-kerry-hatcher.fly.dev/mcp/secured`. The public `/mcp` is a greeting
demo and does not expose website data.

OAuth discovery is served at
`https://htp-api-kerry-hatcher.fly.dev/.well-known/oauth-protected-resource/mcp/secured`.
The authorization server is `https://raxuvdbdfmmtpqjcafcq.supabase.co/auth/v1`.
HTP supports dynamic public-client registration and authorization codes with S256
PKCE. The host owns token storage and refresh. Request `openid offline_access`.
The approval UI is `https://htp.hatchtech.dev/oauth/consent`; open it through the
host's authorization request, not by inventing an authorization ID.

Users review and revoke grants at `https://htp.hatchtech.dev/connections` under
Authorized apps. Revocation blocks renewal; an access token may remain usable
until expiration. OAuth tokens inherit the account's existing permissions; identity
scopes do not make database access read-only. Ownership checks remain in effect.

| Tool | Inputs and behavior |
| --- | --- |
| `list_websites` | Optional `limit` (1–100, default 50), `offset` (default 0). Returns `items`, `has_more`, `next_offset`. |
| `website_saved_data` | Required `fqdn`, `dataset` (`sources`, `snapshots`, `profile_changes`). Optional `job_id` UUID, opaque string `before_id`, `limit` (1–100, default 20). Returns `items`, `has_more`, `next_cursor`. Keep filters unchanged during pagination. |
| `website_repository_history` | Required `fqdn`; optional `start_date`, `end_date` (`YYYY-MM-DD`, UTC) and integer `before_id`. Defaults to a recent range; specify ranges for historical research. Follow `has_more` using the last commit ID. |
| `set_website_repository` | Writes configuration; use only for a requested repository change, through the repository-settings skill. |
| `hello_world_secured` | Authentication greeting; use a real data read to verify research access. |

| Saved kind | Evidence |
| --- | --- |
| `analytics` | GA4 summary, daily, pages, channels and devices |
| `search` | Search Console summary, daily, queries and pages |
| `properties` | Search Console property discovery |
| `conversions` | GA4 conversion/key event reports |
| `pagespeed` | Complete saved PageSpeed/Lighthouse JSON and audit details |
| `crux` | CrUX field metrics and provider collection periods |
| `business_locations` | Saved Business Profile location discovery |
| `business_profile` | Saved full profile snapshots |
| `business_performance` | Saved Business Profile performance reports |

Supported kinds may have no saved data. Business Profile collection can be paused.
`1970-01-01` report dates are sentinels for sources without a date range; use
`fetched_at` to determine observation time. Source freshness states and connection
status describe collection, not the success or failure of the website itself.

Snapshot JSON can be large. Read narrowly by discovered `job_id` and small page
sizes rather than repeatedly loading entire portfolios. Preserve provider metadata
and explain limits when data exceeds the available context.
