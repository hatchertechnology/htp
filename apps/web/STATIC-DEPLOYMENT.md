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

Set `NUXT_PUBLIC_ROLLOUT_PROVIDER_CONNECT=true` on the build after the Rust
provider endpoints, their production-origin CORS policy, and both registered
callbacks have been verified. Use `wrangler.jsonc` for the separate preview.

The first production deployment attaches the custom domain in
`wrangler.production.jsonc`. Record the existing hostname and Fly web DNS
target before replacing the CNAME. Keep the Fly web deployment available for
rollback. Verify the public production hostname serves the built assets and
complete the signed-in workspace and provider checks. If cutover fails,
detach the Cloudflare custom domain and restore the recorded Fly CNAME.
