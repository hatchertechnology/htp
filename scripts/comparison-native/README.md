# Disposable comparison native fixtures

Run from a checkout containing the comparison page and migration. Install the locked web dependencies (`npm ci --prefix apps/web`) and build (`npm run build --prefix apps/web`). Install Playwright Chromium. Cache the images `public.ecr.aws/supabase/postgres:17.11.0.004` and `public.ecr.aws/supabase/postgrest:v14.18` before running. Podman, curl, base64, Node and a free loopback port 31991 are required. The scripts use disposable named containers, a synthetic signing secret and records, and remove their own containers on exit. They never pull images or connect to an existing database. Do not point them at a hosted service.

Both modes apply the six relevant migrations (through `20261205000000_comparison_pilot_scope.sql` and `20261213000000_comparison_semantics_s4.sql`) to a fresh database, insert the pilot approval row for the seeded owner and site, and seed synthetic records only. The browser website/run endpoints are synthetic; comparison RPCs pass through a URL-prefix rewrite to the actual local PostgREST, with no RPC responses mocked. Signed HS256 JWTs and `auth` helper functions are synthetic, not a Supabase Auth test. Browser requests to non-loopback hosts are blocked. Response byte counts are uncompressed HTTP bodies, not hosted limits. The local role setup is a disposable test condition, not a migration or a grant recommendation.

## `./run.sh read` (default)

Seeds the synthetic S15 `controlled-csv-v1` fixture and applies a local ACL overlay that revokes the comparison write functions, leaving only the three read functions. `check.mjs` verifies read-only browser behavior, exact CSV download, saved replay, nonowner denial and held writes.

## `./run.sh full`

Seeds a `controlled-csv-v1` export ([`apps/web/tests/fixtures/comparison-s4/controlled.csv`](../../apps/web/tests/fixtures/comparison-s4/controlled.csv): CRLF, percent-encoded URL, mapped and unmapped rules, present/absent states) paired with the committed SEOsmith schema-4 report `comparison-s4/unicode.json`, an `s15-metadata-2` comparison and a stored `s15-metadata-1` comparison. It grants the eight comparison functions to `authenticated`, modelling the R2 state, and `check-full.mjs` exercises owner import through the actual app entrypoint, exact original download, structured and legacy free-text provenance display, comparison save, pinned replay, report-metadata reset, complete supported/unknown discrepancy categories, and nonowner denial. This does not enable or recommend any hosted grant.

`vectors.json` pins the SEOsmith entity ids (and the sha256 of each committed fixture) that `apps/web/tests/independent-audit-s4.test.ts` asserts against.
