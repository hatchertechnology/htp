# Disposable comparison native fixtures

Run from a checkout containing the comparison page and migration. Install the locked web dependencies (`npm ci --prefix apps/web`) and build (`npm run build --prefix apps/web`). Install Playwright Chromium. Cache the images `public.ecr.aws/supabase/postgres:17.11.0.004` and `public.ecr.aws/supabase/postgrest:v14.18` before running. Podman, curl, base64, Node and a free loopback port 31991 are required. The scripts use disposable named containers, a synthetic signing secret and records, and remove their own containers on exit. They never pull images or connect to an existing database. Do not point them at a hosted service.

Both modes apply the four relevant migrations to a fresh database and seed synthetic records only. The browser website/run endpoints are synthetic; comparison RPCs pass through a URL-prefix rewrite to the actual local PostgREST, with no RPC responses mocked. Signed HS256 JWTs and `auth` helper functions are synthetic, not a Supabase Auth test. Browser requests to non-loopback hosts are blocked. Response byte counts are uncompressed HTTP bodies, not hosted limits. The local role setup is a disposable test condition, not a migration or a grant recommendation.

## `./run.sh read` (default)

Seeds the synthetic S15 `controlled-csv-v1` fixture and applies a local ACL overlay that revokes the comparison write functions, leaving only the three read functions. `check.mjs` verifies read-only browser behavior, exact CSV download, saved replay, nonowner denial and held writes.

## `./run.sh full`

Seeds the realistic locally generated independent-tool export ([`apps/web/tests/fixtures/independent-tool-controlled.csv`](../../apps/web/tests/fixtures/independent-tool-controlled.csv), a `controlled-csv-v1` export with CRLF, quoted fields, mapped and unmapped rules, and present/absent/unknown states) plus its paired controlled SEOsmith report. It keeps the migration's own grants, modelling the normal path once grants are enabled, and `check-full.mjs` exercises owner import through the actual app entrypoint, exact original download, structured and legacy free-text provenance display, comparison save, pinned replay, report-metadata reset, complete supported/unknown discrepancy categories, and nonowner denial. This does not enable or recommend any hosted grant.
