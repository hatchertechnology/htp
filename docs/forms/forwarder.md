# HTP Forms forwarder — trust boundary, limitations and deployment

Status: implementation and disposable tests only. Nothing is deployed, enabled,
routed, or DNS-configured. Production [Formspree](https://formspree.io/) is
untouched. `FORMS_FORWARDER_ENABLED` defaults to `false`.

Source: [`apps/forms-forwarder`](../../apps/forms-forwarder/). Receiving API
edge mode: [`apps/api/src/form_ingress.rs`](../../apps/api/src/form_ingress.rs)
and [authenticated ingress](authenticated-ingress.md).

## Question: can connection-derived client identity be trusted here?

**No, not by the receiving HTP API in this topology.** The official Cloudflare
documentation states the relevant facts directly:

- *“`CF-Connecting-IP` provides the client IP address connecting to Cloudflare
  to the origin web server. This header will only be sent on the traffic from
  Cloudflare's edge to your origin web server.”*
- *“For Worker subrequests destined for a non-Cloudflare customer zone, the
  Worker script controls the client IP headers: both `CF-Connecting-IP` and
  `x-real-ip` can be altered by the Worker.”*
- *“In cross-zone subrequests from one Cloudflare zone to another Cloudflare
  zone, the `CF-Connecting-IP` value will be set to the Worker client IP
  address `2a06:98c0:3600::103` for security reasons.”*
- For `X-Forwarded-For`, Cloudflare **appends** to any client-supplied value
  rather than replacing it, so it is never trustworthy input.

Source: [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

The HTP API runs on Fly, a non-Cloudflare origin. Any `CF-Connecting-IP` or
`X-Real-IP` reaching it was set by our Worker, so the API cannot treat it as a
connection-derived fact: a direct caller could set the same header. Trusting
the connection would also identify Cloudflare's shared egress, not the visitor.

### Selected demonstrably supported provider-owned path

Use the Cloudflare Worker as an **authenticated** forwarder, and keep the API
as the enforcement point:

1. The Worker derives the visitor address from the Cloudflare-set
   `CF-Connecting-IP` on the incoming request; it never reads
   `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, or a caller-supplied
   `CF-Connecting-IP`.
2. The Worker strips every incoming header and builds a fresh request with only
   the public Forms contract headers plus `X-HTP-Client-IP` and
   `X-HTP-Edge-Auth`.
3. `X-HTP-Edge-Auth` is a per-Worker Cloudflare
   [secret binding](https://developers.cloudflare.com/workers/configuration/secrets/),
   64 lowercase hex characters, compared by the API in constant time
   (`subtle::ConstantTimeEq`). `X-HTP-Client-IP` is read only after that
   verification. Anything else fails closed with an opaque 503.
4. The subrequest targets one fixed HTTPS origin with normal certificate and
   hostname verification, redirects disabled, and no user-controlled
   destination.

This uses only documented Cloudflare features (Workers `fetch`, secret
bindings, `secrets.required`) and the reviewed API edge mode. It does not
attempt to make the API trust a connection.

## Recorded limitations

These are explicit and must be re-verified before activation:

1. **The shared secret is a bearer credential.** It authenticates the holder,
   not Cloudflare or the visitor. A leaked key permits identity forgery, so
   the secret must live only in Cloudflare secret storage and the API's
   server-side environment, never in a response, log, trace, or client.
2. **`CF-Connecting-IP` is authoritative only at the Worker, and only when
   Cloudflare is the direct edge.** A stacked CDN/proxy in front of Cloudflare,
   a Worker service binding, or a direct non-Cloudflare invocation can change
   or omit it. Before activation, verify Cloudflare overwrites client-supplied
   `CF-Connecting-IP`/`X-Real-IP` for this hostname (or enable the *Remove
   visitor IP headers* Managed Transform), and confirm no other route or
   private path reaches the Worker. A spoofable address can only skew
   per-client rate-limit keying; the secret, per-form and global limits, and
   origin checks still bound submissions.
3. **Cloudflare egress is shared.** The API must never use the connection
   address of a Worker subrequest for identity or limiting.
4. **Timeouts are ambiguous.** The Worker aborts the upstream fetch at 24 s,
   inside the API's 25 s deadline. A timeout does not prove the API acceptance
   transaction rolled back; clients must retry the identical submission ID and
   payload, and ordinary HTML posts without an ID cannot be deduplicated.
5. **Local tests prove no hosted property.** They run in Miniflare with a
   synthetic upstream. They do not prove TLS, Cloudflare behavior, Fly
   behavior, multi-instance limits, log redaction, or provider configuration.
6. **Runtime bounds.** The Worker caps request bodies at 20,000 bytes, reads
   them into memory (20 KB), streams the upstream response without buffering,
   disables redirects, and performs no retries. Cloudflare's 128 MB memory and
   plan concurrency limits still apply.
7. **Default-off is not a load balancer or WAF.** Unknown-form traffic and
   provider-level abuse still require the separately planned network controls.

## Request contract

- Methods: `POST` and `OPTIONS` only; anything else is an opaque 405.
- Path: exactly `/public/forms/<canonical UUID>`; anything else is an opaque
  404. Query strings and fragments are dropped before forwarding.
- Forwarded request headers (nothing else): `Origin`, `Referer`,
  `Content-Type`, `Accept`; plus rebuilt `X-HTP-Client-IP` and
  `X-HTP-Edge-Auth`.
- Forwarded response headers (nothing else): `Content-Type`,
  `Cache-Control`, `Vary`, `Retry-After`, `Access-Control-Allow-Origin`,
  `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`,
  `Access-Control-Expose-Headers`, `Access-Control-Max-Age`.
- The upstream status, body, and those CORS/receipt headers pass through
  unchanged. The forwarder never invents a receipt and never reflects an
  origin on its own opaque errors.

## Rotation and compromise

- **Rotation:** configure the new random key as `FORMS_EDGE_KEY_CURRENT` on all
  API instances while retaining the old key as `FORMS_EDGE_KEY_PREVIOUS`; switch
  `FORMS_EDGE_KEY` on the Worker; verify convergence through separately
  authorized operational checks; then remove the previous key. Do not leave a
  previous key indefinitely. Coordinate the separate API IP-hash key rotation,
  which resets effective client windows.
- **Compromise:** disable the forwarder and revoke the key immediately. Do not
  use the rotation overlap to preserve availability.

## Testing

```sh
cd apps/forms-forwarder
npm ci
npm run types
npm run check
npm test
```

The suite runs the real bundle in Miniflare (workerd) with `fetch` routed to an
in-process synthetic upstream. It covers: default-off opacity; preflight 204
CORS pass-through; normal POST forwarding with the fixed origin, stripped
client identity/auth headers, and exact receipt/CORS; 429 `Retry-After`
pass-through; path restriction; the 20,000-byte bound; invalid upstream/key
configuration fail-closed; helper validation; and upstream 5xx pass-through.
No network, DNS, real credential, external submission, or hosted change is
involved.

## Rollout gates (separately authorized)

1. Receive the reviewed API edge mode and its constant-time key check.
2. Verify the hosted Cloudflare topology: direct edge only, header overwrite,
   no alternate route, secret isolation, and log redaction.
3. Provision the secret and fixed origin through an authorized
   secret-management process; keep the Worker disabled.
4. Confirm the API's receiver-first rollout, CORS/Origin verification, shared
   admission limits, and rollback path; then enable and exercise a bounded
   normal visitor submission → durable response → authorized inbox.
5. Keep `FORMS_FORWARDER_ENABLED=false` and rotate/revoke on any failure. Never
   restore a public form Edge Function as a fallback.
