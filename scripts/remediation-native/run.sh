#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
pg="remediation-pg-$$"; rest="remediation-rest-$$"; tmp=$(mktemp -d "$PWD/.remediation-native.XXXXXXXX"); export FIXTURE_DIR="$tmp" TMPDIR="$tmp"
cleanup() { local rc=$?; trap - EXIT; for p in ${webpid:-} ${apipid:-} ${issuerpid:-}; do kill "$p" 2>/dev/null || :; wait "$p" 2>/dev/null || :; done; podman rm -f "$rest" "$pg" >/dev/null 2>&1 || :; rm -rf "$tmp"; exit "$rc"; }; trap cleanup EXIT
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
export ISSUER_PORT=$(free_port) API_PORT=$(free_port) WEB_PORT=$(free_port)
podman run --pull=never -d --name "$pg" -e POSTGRES_PASSWORD=fixture-only -p 127.0.0.1::3000 public.ecr.aws/supabase/postgres@sha256:b15d862126dd2dac02da524696ccfde2dcce2ceaee0a58973b2727befe492706 postgres -D /var/lib/postgresql/data >/dev/null
ready=false; for i in {1..60}; do if podman logs "$pg" 2>&1 | grep -q 'PostgreSQL init process complete' && podman exec "$pg" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done; $ready
psqlc() { podman exec -i "$pg" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
psqlc <<'SQL'
create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
grant execute on function auth.jwt(),auth.uid() to public;
SQL
for f in 20261028142440_create_websites.sql 20261028154601_add_website_ga4_property.sql 20261031053344_seosmith_audits.sql 20261031053413_seosmith_history.sql 20261031053524_seosmith_explicit_function_privileges.sql 20261101054016_seosmith_expanded_evidence.sql 20261101060006_seosmith_policy_exclusions.sql 20261116210550_seosmith_versioned_receiver.sql 20261116221958_seosmith_summary_target_lookup.sql 20261116223631_h01_scanner_budget.sql 20261116224641_seosmith_summary_compact_input.sql 20261121120000_seosmith_input_cap.sql 20261121130000_seosmith_rfc3339_intervals.sql 20261202000000_seosmith_remediation.sql; do psqlc < "supabase/migrations/$f"; done
psqlc < scripts/remediation-native/seed.sql
port=$(podman port "$pg" 3000/tcp | sed -n 's/^127\.0\.0\.1:\([0-9]*\)$/\1/p'); [[ "$port" =~ ^[0-9]+$ ]]; export FIXTURE_REST="http://127.0.0.1:$port"
node scripts/remediation-native/issuer.mjs >"$tmp/issuer.log" 2>&1 & issuerpid=$!
for i in {1..30}; do [[ -f "$tmp/jwks.json" ]] && break; sleep 1; done
podman run --pull=never -d --name "$rest" --network "container:$pg" -e PGRST_DB_URI=postgres://authenticator:fixture-only@127.0.0.1:5432/postgres -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e "PGRST_JWT_SECRET=$(cat "$tmp/jwks.json")" public.ecr.aws/supabase/postgrest@sha256:c847127074bd26e1b8d3f7c0e6e01e5346f4b85dd34f5d699fd230af960827c0 >/dev/null
ready=false; for i in {1..30}; do if curl -fsS "$FIXTURE_REST/" >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done; $ready || { podman logs "$rest" >&2; exit 1; }
SUPABASE_URL="http://127.0.0.1:$ISSUER_PORT" SUPABASE_PUBLISHABLE_KEY=fixture HTP_ROLLOUT_REMEDIATION=true BIND_ADDR="127.0.0.1:$API_PORT" target/debug/htp-api >"$tmp/api.log" 2>&1 & apipid=$!
NUXT_API_BASE_URL="http://127.0.0.1:$API_PORT" NUXT_PUBLIC_API_BASE_URL="http://127.0.0.1:$API_PORT" NUXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:$ISSUER_PORT" NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=fixture NUXT_PUBLIC_ROLLOUT_REMEDIATION=true NITRO_HOST=127.0.0.1 NITRO_PORT="$WEB_PORT" node apps/web/.output/server/index.mjs >"$tmp/web.log" 2>&1 & webpid=$!
ready=false; for i in {1..30}; do if curl -fsS "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$API_PORT/" >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done; $ready || { cat "$tmp/"{issuer,api,web}.log >&2; exit 1; }
node scripts/remediation-native/check.mjs || { cat "$tmp/"{issuer,api,web}.log >&2; exit 1; }
