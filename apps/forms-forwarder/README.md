# HTP Forms forwarder

A default-disabled [Cloudflare Worker](https://developers.cloudflare.com/workers/)
that forwards browser form requests to one fixed HTTPS HTP forms API origin.

This is deployment source and tests only. Nothing here is deployed, enabled,
routed, or DNS-configured. The Worker returns an opaque `503
{"error":"temporarily_unavailable"}` until an operator sets
`FORMS_FORWARDER_ENABLED=true`.

Read [`docs/forms/forwarder.md`](../../docs/forms/forwarder.md) for the full
trust model, documented Cloudflare limitations, rotation, and rollout gates.

## Why a forwarder exists

The receiving Fly-hosted API cannot derive the visitor address from the
connection it sees: a Worker subrequest from Cloudflare to a non-Cloudflare
origin is made from Cloudflare's network, and the Worker controls
`CF-Connecting-IP` and `X-Real-IP` on that subrequest. Cloudflare documents
this in
[Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

The supported path is therefore an authenticated boundary:

1. The Worker reads the visitor address only from the Cloudflare-set
   `CF-Connecting-IP` on the **incoming** request and rebuilds the outgoing
   request headers from scratch.
2. The Worker authenticates to the API with a 64-lowercase-hex shared secret
   in `X-HTP-Edge-Auth` (a Cloudflare [secret binding](https://developers.cloudflare.com/workers/configuration/secrets/)).
3. The API verifies the secret in constant time and only then reads
   `X-HTP-Client-IP`; without the secret it fails closed. See
   [`apps/api/src/form_ingress.rs`](../../apps/api/src/form_ingress.rs) and
   [`docs/forms/authenticated-ingress.md`](../../docs/forms/authenticated-ingress.md).

## Bindings

| Name | Kind | Required | Purpose |
|------|------|----------|---------|
| `FORMS_FORWARDER_ENABLED` | var | yes | `"true"` enables forwarding. Any other value returns an opaque 503. |
| `FORMS_UPSTREAM_ORIGIN` | var | yes | Fixed HTTPS origin (scheme and host only, no path/query/credentials). |
| `FORMS_EDGE_KEY` | secret | yes | 64 lowercase hex characters matching the API `FORMS_EDGE_KEY_CURRENT`. |

`secrets.required` in `wrangler.jsonc` makes `wrangler deploy` fail until
`FORMS_EDGE_KEY` is configured.

## Commands

```sh
npm ci
npm run types          # generates worker-configuration.d.ts from wrangler.jsonc
npm run check          # tsc --noEmit
npm test               # Miniflare (workerd) tests with a synthetic upstream
npm run deploy:dry-run # bundles and validates config; does not deploy
```

## Deployment (separate authorization required)

Do not run these as part of this task. At an authorized rollout:

1. Confirm the HTP API runs in the reviewed edge identity mode with
   `FORMS_EDGE_KEY_CURRENT` configured; keep `FORMS_FORWARDER_ENABLED=false`.
2. Set the fixed origin: `wrangler secret put` is **not** used for
   `FORMS_UPSTREAM_ORIGIN`; it is a plain var. Set it to the exact HTTPS API
   origin, for example `https://api.htp.example`.
3. Set the secret with `wrangler secret put FORMS_EDGE_KEY` (only in an
   authorized secret-management step; never commit it).
4. Attach the intended browser-facing route/custom domain during the
   authorized deployment. Keep `workers_dev` and preview URLs disabled.
5. Verify Cloudflare overwrites client-supplied `CF-Connecting-IP`/`X-Real-IP`
   for this hostname, that no other route reaches the Worker, and that logs do
   not capture `X-HTP-Edge-Auth`.
6. Enable only after the API, receiver-first rollout, and hosted checks pass;
   watch for CORS and receipt parity, and be ready to set
   `FORMS_FORWARDER_ENABLED=false` and rotate the key.

## What the tests prove

`npm test` runs the real bundle in Miniflare (workerd) with `fetch` routed to
an in-process synthetic upstream. It proves default-off behavior, preflight and
receipt pass-through, exact allowlisted request/response headers, stripped
client-supplied identity/auth headers, the fixed origin, the body bound, and
fail-closed configuration. It contacts no network, resolves no DNS, uses no
real credential, and submits nothing. It does not prove any hosted Cloudflare
or Fly property; see `docs/forms/forwarder.md`.
