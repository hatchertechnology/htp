# Static dashboard deployment

Cloudflare serves the generated Nuxt assets for `htp.hatchtech.dev`. The
browser sends HTP operations to the Rust API on Fly. Provider authorization
starts and returns on the Fly API host.

From `apps/web`, generate the production build with the existing page sampling
feature enabled:

```sh
NUXT_PUBLIC_PAGE_PERFORMANCE_SAMPLES=true npm run build:static
npm run static:smoke
npx --yes wrangler@4.168.0 deploy --config wrangler.production.jsonc --dry-run
```

Use `wrangler.jsonc` for the separate public `workers.dev` preview and its
version URLs. Use it to check assets, routes and unauthenticated behavior.
Build it with public configuration only. With the API restricted to the
production origin, run signed-in checks on the production hostname. Set
`NUXT_PUBLIC_ROLLOUT_PROVIDER_CONNECT=true` on the production build after both
registered Fly callbacks and the Rust provider flow have been verified.

1. Record the current Fly release, API origin and provider rollout settings,
   and the dashboard build flags. Configure
   `HTP_DASHBOARD_CORS_ORIGIN=https://htp.hatchtech.dev` on Fly and
   verify the production-origin preflights. Keep
   `HTP_WEB_MANAGEMENT_HOST=htp-web-kerry-hatcher.fly.dev` for any held
   compatibility operations. Check that those operations still reach Fly.
2. Select the Kerry Personal Cloudflare account containing the active
   `hatchtech.dev` zone. Keep the healthy Fly web deployment and its hostname
   certificate available for rollback. Record the existing CNAME target, proxy
   status and TTL. Lower its TTL in advance and allow the previous TTL to expire.
3. During cutover, remove the existing CNAME for `htp.hatchtech.dev` and deploy
   with `npx --yes wrangler@4.168.0 deploy --config wrangler.production.jsonc`.
   The deployment attaches the custom domain. A dry run checks the asset
   package. Domain ownership and certificate readiness are checked at cutover.
4. Verify HTTPS and the exact deployed assets at the production hostname.
   Check the signed-in workspace, page sampling, provider status and consent.
   DNS and certificate changes can take time to propagate.

For an asset regression, roll back the Cloudflare deployment to its previous
working version. For a failed hostname cutover, remove `htp.hatchtech.dev`
from the dashboard Worker’s Domains & Routes settings, then recreate the
recorded Fly CNAME with its prior proxy setting and TTL. Verify public HTTPS
and signed-in behavior on Fly. Restore the API origin and rollout settings
from the pre-cutover snapshot if they changed. The Fly management selector
can continue to point at the direct Fly web hostname.
