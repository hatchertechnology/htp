# Native provider OAuth (Wave 1, held by default)

Cloudflare serves static assets only. The browser talks directly to the Rust/Fly
API. No Worker, Pages function, Nitro OAuth proxy, or Cloudflare callback is
required. Existing Nitro source and background collectors are unchanged.

## Browser contract

1. POST `/providers/google/connect` or `/providers/bing/connect` with the owner's
   Supabase Bearer token, no body, and the exact existing trusted dashboard
   Origin. Use ordinary credential-free CORS (`credentials: omit`).
2. Read `{ "url": "https://<configured-api>/auth/<provider>/start?ticket=..." }`.
   Validate the exact configured API origin, the matching provider start path,
   and exactly one `ticket` parameter matching `^[A-Za-z0-9_-]{43}$`; no fragment
   or userinfo. Navigate the current tab to that URL. It is an API launch URL,
   not a provider URL. Do not persist/log the ticket or include a bearer in it.
3. Launch requires a Referer from the exact trusted dashboard origin. Retain
   the dashboard's `strict-origin-when-cross-origin` referrer policy. Missing or
   different Referer fails closed. This prevents a shared launch link from
   linking a victim's provider grant to the link creator's HTP owner account.
4. The API sets a host-only Secure HttpOnly SameSite=Lax state cookie, then
   redirects to Google `https://accounts.google.com/o/oauth2/v2/auth` or Bing
   `https://www.bing.com/webmasters/oauth/authorize`.
5. Provider GET callbacks terminate directly at the Fly API:
   `/auth/google/callback` and `/auth/bing/callback`. Callback authentication is
   the sealed owner-bound state cookie plus constant-time state validation;
   no Supabase bearer or dashboard cookie is expected on provider navigation.
6. Redirects go only to the configured dashboard `/connections`, with exactly
   `google=<outcome>` or `bing=<outcome>`. Outcomes are `connected`, `denied`,
   `invalid_state`, `failed`, `stale_consent`; Google also supports `missing_scope`. No query
   field can supply an origin/path. Responses are private/no-store/no-referrer.

Connect routes use the existing Supabase verifier (rejecting anonymous users).
CORS adds only these two POST paths, with no credential allowance or new origins.
GET start and callback routes have no browser fetch/CORS requirement. Google
requests Analytics and Search Console read-only scopes, offline consent and S256
PKCE; Business Profile stays disabled as in the existing web feature flag. Bing
retains webmaster.read consent and accepts the provider's `Read` scope spelling.
All provider exchanges disable redirect following and have a 15-second deadline;
provider response bodies are bounded to 64 KiB. No code, token, state, ticket,
provider body, or grant logging is added.

## Configuration and rollout

`HTP_ROLLOUT_PROVIDER_OAUTH` must equal `true` to enable native OAuth. It is unset
by default in code and explicitly `false` in fly.toml. Until enabled, new start,
launch and callback operations return 503; existing connection status/disconnect and owner inspection
continue through their legacy owner bridge. If enabled but incomplete/invalid,
all native OAuth operations fail closed with 503; there is no exchange fallback
to Nitro. Status/disconnect and owner inspection select native Rust when the gate is true.
Status reports each provider’s configured state independently, matching Nitro;
missing store or inspection configuration fails closed without bridge fallback.

Enabling requires all of these API environment settings (names only; no values
are stored here):

- `HTP_PROVIDER_OAUTH_API_ORIGIN`: exact HTTPS Fly API origin, no trailing slash,
  path, query, credentials or fragment.
- `HTP_DASHBOARD_CORS_ORIGIN`: the **existing** explicitly trusted dashboard
  origin; do not widen it. Native launches and fixed outcomes use this origin.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: the existing grant database and
  server-only grant-storage credential. The service credential is never returned
  or used as owner authentication.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_COOKIE_KEY`;
  `BING_CLIENT_ID`, `BING_CLIENT_SECRET`, `BING_COOKIE_KEY`. Both providers must be
  configured for this gate. Cookie keys are standard-base64 encoded 32-byte
  values and must match the corresponding existing Nitro/collector keys.

The static frontend's separate `rolloutProviderConnect` remains false until the
receiver, browser contract, registrations and handshake routing are qualified.
This change performs no activation, migration, registration, deploy or live test.

### Redirect registrations required before enabling

For the current API hostname, register these exact redirect URIs on the existing
provider clients, retaining the existing web redirect registrations during rollout:

- Google: `https://htp-api-kerry-hatcher.fly.dev/auth/google/callback`
- Bing: `https://htp-api-kerry-hatcher.fly.dev/auth/bing/callback`

If a different API origin is selected, register its exact callback equivalents
and configure that same origin. No Cloudflare/frontend callback URI is used by
the native flow. Registration availability has not been inspected or changed.

### Handshake routing limitation

Launch tickets and active callback states use one bounded (1024 entries, at most
eight per owner across both providers after expiry pruning),
10-minute, in-process ledger, shared by this app's routes. Navigation through
start and callback must reach the same running API process as connect. A restart,
stop or another replica fails closed; it cannot recover a pending connection.
Do not enable on an unqualified multi-process/auto-stop rollout. The current Fly
configuration has auto-stop enabled and has not been changed by this patch.
Qualify single-process continuity for the handshake window or replace this ledger
with a shared expiring atomic store before activation. This limitation does not
affect already persisted grants. Rollback disables the API gate and frontend flag;
legacy routes and saved grants remain intact.

## Grant and legacy compatibility

Writes target existing `google_connections` and `bing_connections`, keyed by the
verified pending owner, with fresh generation UUID, status, updated_at, Google
scopes, and `encrypted_grant`. Native writes require the standalone
`20261206000000_provider_consent_fence.sql` migration. Connection table columns
and existing data are unchanged. Encryption exactly
matches Nitro's AES-256-GCM layout: base64url(12-byte IV || 16-byte tag || ciphertext),
with AAD `htp_<provider>_grant:<owner UUID>` and JSON `{user,refresh,scopes}`. Access
tokens are never stored. Existing collectors, rotation RPCs, generation fences,
MCP/owner inspection consumers and Nitro decryptors continue using those rows.

REST GET/DELETE `/providers/{google|bing}/connection` and MCP provider tools
share the native grant store when the gate is true. POST
`/websites/{id}/search/owner-inspect` and MCP URL inspection share native Google
refresh and the existing Rust inspection implementation. The held gate preserves
the existing Nitro bridges. Cloudflare remains static assets only.

Legacy browser-only Google cookies remain accessible only on the old web host.
The API cannot read or delete another host's cookie. Migrate through existing
Nitro before cutover, or reconnect natively. Tombstones prevent legacy migration
from restoring an account-wide disconnected grant. No browser credential or
caller-supplied Google token is accepted by native owner inspection.

### Native operations — activation still blocked

`provider_management.rs` uses verified nonanonymous owner identity for grant
reads and writes. Status projects metadata only. Disconnect creates a fresh
UUID generation and empty tombstone, clearing Google scopes. Inspection checks
website ownership and property/URL boundaries before refreshing Search Console
credentials. Refresh tokens remain encrypted in the existing format; access
tokens stay request-local. Rotated refresh persistence uses
`rotate_google_grant` with the generation originally read with the grant. A lost
CAS cannot overwrite a reconnect or disconnect. Shared MCP/REST errors retain
the existing sanitized status mapping, and REST responses are private/no-store.
Provider and grant-store transport disables redirects, has a 15-second deadline,
and bounds JSON responses to 64 KiB.

### Atomic native consent contract

The native callbacks now use `complete_provider_consent`, never a connection
upsert. `begin_provider_consent` materializes a service-only fence row keyed by
verified owner and provider, serializes on that row, and returns its UUID epoch
plus the current connection generation (null for absence). Connect binds this
snapshot into both the process ledger and sealed cookie before issuing a ticket.
It does not create a connection row or change an existing grant.

`disconnect_provider_consent` holds the same fence lock, advances its epoch,
and writes the fresh-generation disconnected tombstone in one transaction,
including when no connection exists. Callback locks the fence and requires the
captured epoch. For an existing connection it updates only the captured generation;
for absence it inserts with `ON CONFLICT DO NOTHING`. It advances the epoch only
if exactly one grant row was written. False CAS returns `stale_consent`; it never
falls back to an upsert, retries, or claims connected. Competing callbacks from
one snapshot have at most one winner. A later explicit connect obtains a fresh
snapshot. Both provider and owner identities partition the fence.

All three RPCs are security invoker with an empty search path and explicit
service-only EXECUTE. The fence table has RLS, no owner/anonymous policies, and
only SELECT/INSERT/UPDATE for service_role. Existing connection ACLs and refresh
RPCs remain unchanged. Transport/SQL errors and malformed RPC responses fail
closed. An HTTP failure after commit is an uncertain outcome; the API does not
retry or report success. A user can check status and explicitly reconnect.

Only native operations participate in the shared epoch. Existing Nitro writers
and collectors retain their behavior. Captured connection-generation CAS also
protects callbacks against an intervening existing writer that changes generation,
including concurrent insert of a previously absent connection. This does not
retrofit epoch checks into legacy callbacks: drain legacy handshakes before
native cutover and do not claim safe mixed legacy/native consent activation.

### Individual ledger45 application and rollback

The migration was CLI-created and then ordered at `20261206000000`, after all
currently queued migrations. It depends only on `auth.users` and the original
Google/Bing connection tables, not remediation, event queue, bounded search or
comparison-pilot migrations. Do not use a blanket database push to apply it on
hosted ledger45, as that would include unrelated pending migrations.

`python3 supabase/deploy/provider-consent-fence-ledger45.py` prints an atomic,
reviewable single-migration candidate: locks the migration ledger, requires the
45 known versions through `20261201000000`, applies just the consent SQL, and
inserts only its ledger record. It stores the exact multi-statement migration
body in one statements-array item. It does not execute SQL or access a server.
`--rollback` prints the inverse, requiring the expected 46 versions and exact
consent ledger name/source before dropping only the new RPCs/table and deleting
only that ledger entry. Existing connection rows, evidence and generations stay
intact. The raw schema rollback also exists in `supabase/rollbacks/` and leaves
ledger management to the release operator.

The version guard is not a full hosted catalog/ACL/role/default/event guard.
Independent review must reconcile the fresh hosted baseline, canonical ledger
record convention, effective privileges, and existing lifecycle/Forms guards,
which currently pin ledger45. This patch performs no hosted application and
supplies no authorization to bypass those guards. Hold native rollout, drain
pending consent and restart the singleton before rollback or switching writers.
Reapplication creates new epochs, so old pending callbacks fail closed.

The singleton/no-auto-stop handshake requirement still blocks activation until
qualified. No Fly settings, rollout flags, registrations or bridge code changed.

## Synthetic verification

`cargo test -p htp-api --tests` exercises API library and integration fixtures.
New provider tests use only synthetic credentials, in-memory requests, and local
loopback token/storage servers. They cover auth/CORS, exact origins and launch
Referer, state/cookie/expiry/replay, Google PKCE and token form encoding, scope and
refresh rejection, fixed redirects, bounded provider transport, storage failures,
legacy Node crypto format and unchanged provider bridge tests. No live
provider, database, browser consent, or production verification is claimed.

`python3 supabase/tests/provider-consent-pg17/run.py` creates a disposable,
network-disabled PG17 container, reconstructs the 45-migration synthetic baseline,
and exercises isolated application/rollback, service-only ACLs, absent/existing
connection races, disconnect/callback ordering, concurrent callbacks, reconnect,
owner/provider separation, external generation changes and injected SQL failures.
It uses no restored data, production connection or credentials.
