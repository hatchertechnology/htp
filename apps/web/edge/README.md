# Static OAuth compatibility candidate

Source only; the default `../wrangler.jsonc` remains asset-only. The separate
`../wrangler.oauth-candidate.jsonc` is opt-in and has no route, domain, workers.dev,
preview URL, secrets, build hook, or deployment script. Do not use it as evidence
that production cutover or provider configuration has been validated.

The official [Static Assets binding documentation](https://developers.cloudflare.com/workers/static-assets/binding/)
defines `assets.run_worker_first` selective routing. This candidate lists exactly:

- POST `/api/google/connect`
- POST `/api/bing/connect`
- GET `/auth/google/callback`
- GET `/auth/bing/callback`

Cloudflare matches paths, so the handler enforces methods and the fixed public
origin `https://htp.hatchtech.dev`. The only upstream is the fixed HTTPS Nitro host
`htp-web-kerry-hatcher.fly.dev`. No caller-controlled origin, path, redirect or
header can select another upstream. Upstream redirects are never followed.

Nitro remains responsible for verifying the owner bearer, sealing/validating the
state cookie, PKCE, provider exchanges and storing grants. See
`server/utils/google.ts` (`requireDashboardUser`, `startGoogle`, `finishGoogle`)
and `server/utils/bing.ts` (`startBing`, `finishBing`). Connect forwards only the
validated bearer syntax and optional matching Origin; it drops cookies, body and
query. Callback forwards only that provider's opaque state cookie and the
`code`, `state`, `error` query fields. Duplicate query fields remain duplicates;
ambiguous duplicate state cookies are omitted for Nitro to reject. No bearer is
forwarded on callbacks. The state cookie's existing Secure, HttpOnly, SameSite=Lax,
Path=/ and expiry attributes are preserved verbatim, including deletion. Google
legacy grant-cookie deletion is also preserved; grant-cookie creation is blocked.

Callback locations are limited to the exact relative results currently emitted
by Nitro. Callback bodies are discarded. Connect retains Nitro's JSON body and
status. Response headers are allowlisted; all auth responses, including errors,
are private/no-store with no-referrer. Fetch failures return a fixed error without
logging exceptions, URLs, codes, cookies or tokens. Observability is explicitly
disabled because invocation logs/traces can capture callback URLs.

Other requests never go to Nitro. Asset-first requests retain Cloudflare's normal
asset/SPA behavior (including unrelated `/api` paths). If the script is invoked
for a miss, it refuses `/api/` and `/auth/` paths and sends ordinary GET/HEAD asset
requests without query, cookies, authorization or referrer. Selective routing
cannot sanitize requests served directly by Cloudflare's asset layer; this
entrypoint never sends callback codes/tokens to ASSETS. No claim is made about
external browser/platform logging settings outside this source candidate.

Local checks (synthetic values only):

```sh
node --test apps/web/edge/static-oauth.test.mjs
node apps/web/edge/static-oauth.wrangler.test.mjs /path/to/wrangler/bin/wrangler.js
```

The Wrangler check uses temporary HOME/config/assets, local mode, no metrics and
no dev vars. Four deliberately colliding OAuth assets prove worker-first routing;
four other paths prove asset/SPA behavior. All OAuth requests in that check have
a local, rejected origin, so they cannot contact the fixed hosted backend. The
transport unit tests inject an in-memory upstream to exercise successful flows,
cookies, header minimization, redirects and failures. They do not validate live
provider credentials, the backend's current appOrigin or deployed cookie behavior.
