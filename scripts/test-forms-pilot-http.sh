#!/usr/bin/env bash
# Synthetic, disposable loopback-only PG17/PostgREST/API/browser integration.
set -euo pipefail
cd "$(dirname "$0")/.."
pg="forms-pilot-fixture-pg-$$-${RANDOM}"
rest="forms-pilot-fixture-rest-$$-${RANDOM}"
pg_created=false
rest_created=false
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/forms-pilot-ci.XXXXXXXX")
cleanup() {
  local result=$? name
  trap - EXIT
  if ! docker info >/dev/null 2>&1; then echo 'cannot verify fixture container cleanup' >&2; result=1; fi
  for name in "$rest" "$pg"; do
    if docker inspect "$name" >/dev/null 2>&1; then
      if [[ "$name" == "$pg" && "$pg_created" != true ]] || [[ "$name" == "$rest" && "$rest_created" != true ]]; then
        echo "cannot verify ownership of container: $name" >&2; result=1; continue
      fi
      if ! docker rm -f "$name" >/dev/null; then echo "fixture cleanup failed: $name" >&2; result=1; fi
      if docker inspect "$name" >/dev/null 2>&1; then echo "fixture remains: $name" >&2; result=1; fi
    fi
  done
  if ! rm -rf -- "$tmpdir"; then echo 'fixture temporary directory cleanup failed' >&2; result=1; fi
  if (( result == 0 )); then echo 'PASS: fixture containers and temporary files removed'; fi
  exit "$result"
}
trap cleanup EXIT

docker run -d --name "$pg" -e POSTGRES_PASSWORD=fixture-only -p 127.0.0.1::3000 public.ecr.aws/supabase/postgres@sha256:e85bc10ac5b141223b289e1e8dc8d448cf3df92501917149db0366b9c5aaf053 postgres -D /var/lib/postgresql/data >/dev/null
pg_created=true
ready=false
for attempt in {1..60}; do
  docker logs "$pg" > "$tmpdir/postgres.log" 2>&1
  if grep -Fq 'PostgreSQL init process complete' "$tmpdir/postgres.log" && docker exec "$pg" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$pg")" != true ]]; then docker logs "$pg" >&2; exit 1; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'fixture PostgreSQL did not start' >&2; exit 1; fi

docker exec -i "$pg" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
grant execute on function auth.jwt(),auth.uid() to public;
SQL
for file in \
  20261028142440_create_websites.sql \
  20261122000000_website_forms.sql \
  20261122000100_forms_acceptance.sql \
  20261122000200_forms_host_verification.sql \
  20261122000300_forms_management.sql \
  20261122000400_forms_notifications.sql \
  20261122000500_forms_response_deletion.sql \
  20261122000600_forms_rename_safety.sql \
  20261122000700_forms_ingress_gate.sql \
  20261122000800_forms_uncertain_retry.sql \
  20261122000900_forms_client_admission.sql \
  20261128000000_forms_host_challenge_quota.sql \
  20261201000000_forms_pilot_scope.sql; do
  docker exec -i "$pg" psql -U postgres -v ON_ERROR_STOP=1 -q < "supabase/migrations/$file"
done
approvals=$(docker exec "$pg" psql -U postgres -At -v ON_ERROR_STOP=1 -c 'select count(*) from public.forms_pilot_approved_sites')
[[ "$approvals" == 0 ]] || { echo 'pilot migration did not start with an empty approval table' >&2; exit 1; }
# Seed is local-only; remove its synthetic approval to verify default denial.
{ printf "select set_config('forms.pilot_fixture','disposable',false);\n"; cat supabase/tests/fixtures/forms-pilot-scope/seed.sql; } | docker exec -i "$pg" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q
docker exec "$pg" psql -U postgres -v ON_ERROR_STOP=1 -q -c "delete from public.forms_pilot_approved_sites where website_id='00000000-0000-0000-0000-000000000003'"
docker run -d --name "$rest" --network "container:$pg" \
  -e PGRST_DB_URI=postgres://authenticator:fixture-only@127.0.0.1:5432/postgres \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET=fixture-only-secret-at-least-thirty-two-bytes \
  public.ecr.aws/supabase/postgrest@sha256:c847127074bd26e1b8d3f7c0e6e01e5346f4b85dd34f5d699fd230af960827c0 >/dev/null
rest_created=true
port=$(docker port "$pg" 3000/tcp | sed -n 's/^127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p')
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1024 )); then echo 'expected loopback PostgREST port' >&2; exit 1; fi
export PILOT_FIXTURE=disposable PILOT_FIXTURE_URL="http://127.0.0.1:$port/"
ready=false
for attempt in {1..30}; do
  if curl -fsS "$PILOT_FIXTURE_URL" >/dev/null; then ready=true; break; fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$rest")" != true ]]; then docker logs "$rest" >&2; exit 1; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'fixture PostgREST did not start' >&2; exit 1; fi
PILOT_FIXTURE_PHASE=held8 node supabase/tests/fixtures/forms-pilot-scope/postgrest-check.mjs
PILOT_FIXTURE_PHASE=service_acl node supabase/tests/fixtures/forms-pilot-scope/postgrest-check.mjs
export FORMS_TEST_DB="http://127.0.0.1:$port"
FORMS_TEST_SERVICE_JWT=$(node -e 'const c=require("crypto");const e=x=>Buffer.from(JSON.stringify(x)).toString("base64url");const b=e({alg:"HS256",typ:"JWT"})+"."+e({role:"service_role",exp:Math.floor(Date.now()/1000)+3600});process.stdout.write(b+"."+c.createHmac("sha256","fixture-only-secret-at-least-thirty-two-bytes").update(b).digest("base64url"))')
export FORMS_TEST_SERVICE_JWT
run_browser() {
  local mode=$1
  FORMS_PILOT_BROWSER_MODE="$mode" cargo test --locked -p htp-api --lib form_ingress::tests::disposable_pilot_postgrest_browser_cors -- --ignored --exact --nocapture | tee "$tmpdir/$mode.log"
  grep -Fq '1 passed; 0 failed' "$tmpdir/$mode.log" || { echo 'pilot browser test did not execute' >&2; return 1; }
  grep -Fq "PASS: pilot-scoped API browser $mode" "$tmpdir/$mode.log" || { echo 'pilot browser evidence missing' >&2; return 1; }
}
run_browser denied
docker exec "$pg" psql -U postgres -v ON_ERROR_STOP=1 -q -c "insert into public.forms_pilot_approved_sites values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001')"
run_browser approved
docker exec "$pg" psql -U postgres -v ON_ERROR_STOP=1 -q -c "delete from public.forms_pilot_approved_sites where website_id='00000000-0000-0000-0000-000000000003'"
run_browser denied
# Verify the accepted row persists and the revoked same-ID request never wrote twice.
rows=$(docker exec "$pg" psql -U postgres -At -v ON_ERROR_STOP=1 -c "select count(*) from public.website_form_responses where submission_id='00000000-0000-0000-0000-000000000022'")
[[ "$rows" == 1 ]] || { echo 'unexpected persisted response count' >&2; exit 1; }
echo 'PASS: disposable PG17/PostgREST/API/browser pilot gate'
