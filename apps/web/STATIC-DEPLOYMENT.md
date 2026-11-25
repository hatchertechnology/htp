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
   verify the production-origin preflights. (The cutover is complete. The
   Nitro Fly web app `htp-web-kerry-hatcher` was retired on 2026-11-25, and
   `HTP_WEB_MANAGEMENT_HOST` now accepts only `htp.hatchtech.dev`.)
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
working version. The Fly web dashboard is retired, so rolling the hostname
back to Fly is no longer possible.

Owner Forms notification management is separately default-off:
`NUXT_PUBLIC_ROLLOUT_FORMS_NOTIFICATIONS=true` must be explicitly baked into the
static build, alongside the existing Forms pilot flag. The panel also requires a
successful authenticated pilot eligibility read. The API's separate
`HTP_FORMS_OWNER_NOTIFICATION_API` gate and exact pilot owner/site fence remain
required. This source change enables none of those gates or database grants.
Recipients and delivery jobs use bearer-authenticated owner routes under
`/websites/{id}/forms/{form_id}`; static notification management never uses
Supabase tables/RPCs. Queue acceptance is not delivery. Unknown writes lock all
notification writes until an explicit successful recipients/jobs readback;
operators must also reconcile provider records before uncertain delivery retries.
