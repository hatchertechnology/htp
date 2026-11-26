#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mode="${1:-read}"
case "$mode" in
  read) csv_file=apps/web/tests/fixtures/s15-controlled.csv; report_file=apps/web/tests/fixtures/s15-engine-report.json; seed=scripts/comparison-native/seed.sql; flag='NUXT_PUBLIC_ROLLOUT_COMPARISONS_READ_ONLY=true'; check=scripts/comparison-native/check.mjs ;;
  full) csv_file=apps/web/tests/fixtures/comparison-s4/controlled.csv; report_file=apps/web/tests/fixtures/comparison-s4/unicode.json; seed=scripts/comparison-native/seed-full.sql; flag='NUXT_PUBLIC_ROLLOUT_COMPARISONS=true'; check=scripts/comparison-native/check-full.mjs ;;
  *) echo "usage: $0 [read|full]" >&2; exit 2 ;;
esac
pg="comparison-pg-$$"; rest="comparison-rest-$$"; tmp=$(mktemp -d "$PWD/.comparison-native.XXXXXXXX"); export TMPDIR="$tmp"
pg_created=false; rest_created=false
cleanup() { local rc=$?; trap - EXIT; [[ -z "${webpid:-}" ]] || { kill "$webpid" 2>/dev/null || :; wait "$webpid" 2>/dev/null || :; }; if [[ "$rest_created" == true ]]; then podman rm -f "$rest" >/dev/null || rc=1; fi; if [[ "$pg_created" == true ]]; then podman rm -f "$pg" >/dev/null || rc=1; fi; rm -rf "$tmp" || rc=1; exit "$rc"; }
trap cleanup EXIT
podman run --pull=never -d --name "$pg" -e POSTGRES_PASSWORD=fixture-only -p 127.0.0.1::3000 public.ecr.aws/supabase/postgres:17.11.0.004 postgres -D /var/lib/postgresql/data >/dev/null
pg_created=true
for i in {1..60}; do if podman logs "$pg" 2>&1 | grep -q 'PostgreSQL init process complete' && podman exec "$pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi; sleep 1; done
podman exec -i "$pg" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
grant execute on function auth.jwt(),auth.uid() to public;
SQL
# The whole migration ledger in order (57 at the Wave 1 baseline) plus the comparison migration under test.
for f in supabase/migrations/*.sql; do [[ -f "$f" ]]; podman exec -i "$pg" psql -U postgres -v ON_ERROR_STOP=1 -q < "$f" >/dev/null; done
podman exec -i "$pg" psql -U postgres -v ON_ERROR_STOP=1 -q -v csv="$(base64 -w0 "$csv_file")" -v report="$(cat "$report_file")" < "$seed"
podman run --pull=never -d --name "$rest" --network "container:$pg" -e PGRST_DB_URI=postgres://authenticator:fixture-only@127.0.0.1:5432/postgres -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET=fixture-only-secret-at-least-thirty-two-bytes public.ecr.aws/supabase/postgrest:v14.18 >/dev/null
rest_created=true
port=$(podman port "$pg" 3000/tcp | sed -n 's/^127\.0\.0\.1:\([0-9]*\)$/\1/p'); [[ "$port" =~ ^[0-9]+$ ]]
export FIXTURE_REST="http://127.0.0.1:$port"
ready=false; for i in {1..30}; do if curl -fsS "$FIXTURE_REST/" >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done; [[ "$ready" == true ]] || { podman logs "$rest" >&2; exit 1; }
python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",31991)); s.close()'
env NUXT_API_BASE_URL=http://127.0.0.1:9 NUXT_PUBLIC_API_BASE_URL=http://127.0.0.1:9 NUXT_PUBLIC_SUPABASE_URL="$FIXTURE_REST" NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=fixture "$flag" NITRO_HOST=127.0.0.1 NITRO_PORT=31991 node apps/web/.output/server/index.mjs >"$tmp/web.log" 2>&1 & webpid=$!
ready=false; for i in {1..30}; do if curl -fsS http://127.0.0.1:31991/ >/dev/null 2>&1; then ready=true; break; fi; kill -0 "$webpid" 2>/dev/null || break; sleep 1; done; [[ "$ready" == true ]] || { cat "$tmp/web.log" >&2; exit 1; }
node "$check"
