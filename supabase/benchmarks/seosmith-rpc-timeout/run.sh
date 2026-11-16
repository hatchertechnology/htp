#!/usr/bin/env bash
# Disposable local test; no hosted DB. Requires Podman, Node, curl and storage-backed TMPDIR.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/htp-rpc-budget.XXXXXXXX"); PG="htp-rpc-pg-$$"; REST="htp-rpc-rest-$$"; PGPORT=${PGPORT:-55442}; RESTPORT=${RESTPORT:-55443}
cleanup(){ podman rm -f "$REST" "$PG" >/dev/null 2>&1 || true; python3 -c 'import shutil,sys;shutil.rmtree(sys.argv[1])' "$WORK"; }; trap cleanup EXIT
podman run -d --rm --name "$PG" --memory 10g --shm-size 1g -e POSTGRES_PASSWORD=dryrun -p "127.0.0.1:$PGPORT:5432" public.ecr.aws/supabase/postgres:17.11.0.004 >/dev/null
pg(){ podman exec -i -e PGPASSWORD=dryrun "$PG" psql -X -v ON_ERROR_STOP=1 -q -U supabase_admin -h 127.0.0.1 -d postgres "$@"; }
for _ in $(seq 1 60); do pg -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
pg <<'SQL'
create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim',true),''),nullif(current_setting('request.jwt.claims',true),''))::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid$$;
alter role authenticator password 'local-only-password'; alter role anon set statement_timeout='3s'; alter role authenticated set statement_timeout='8s'; alter role authenticator set statement_timeout='8s';
SQL
for f in "$ROOT"/supabase/migrations/*.sql; do pg -1 -f - < "$f" >/dev/null; done
pg <<'SQL'
insert into auth.users(id) values('00000000-0000-4000-8000-0000000000aa');
insert into public.websites(id,owner_id,fqdn) values('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000aa','example.com');
insert into public.seosmith_bindings(website_id,token_sha256) values('00000000-0000-4000-8000-000000000002',encode(sha256(convert_to(repeat('x',64),'UTF8')),'hex'));
create table public.timeout_probe_rows(v text);
create function public.timeout_hoist_success() returns text language plpgsql set statement_timeout='5s' as $$begin perform pg_sleep(4); return current_setting('statement_timeout'); end$$;
create function public.timeout_hoisted_probe() returns text language plpgsql security definer set statement_timeout='4s' as $$begin insert into public.timeout_probe_rows values ('rolled-back'); perform pg_sleep(5); return 'unexpected'; end$$;
create function public.timeout_unrelated_probe() returns text language plpgsql as $$begin perform pg_sleep(4); return 'done'; end$$;
create function public.timeout_auth_limit() returns text language plpgsql as $$begin perform pg_sleep(9); return 'done'; end$$;
grant execute on function public.timeout_hoist_success(),public.timeout_hoisted_probe(),public.timeout_unrelated_probe(),public.timeout_auth_limit() to anon,authenticated;
SQL
podman run -d --rm --name "$REST" --network host -e PGRST_DB_URI="postgres://authenticator:local-only-password@127.0.0.1:$PGPORT/postgres" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_SERVER_PORT="$RESTPORT" -e PGRST_JWT_SECRET='local-test-secret-at-least-32-bytes-long' public.ecr.aws/supabase/postgrest:v14.18 /bin/postgrest >/dev/null
podman exec "$REST" /bin/postgrest --version
podman exec "$REST" /bin/postgrest --dump-config | grep db-hoisted-tx-settings
mkdir "$WORK/p"; node "$HERE/gen.cjs" "$ROOT/supabase/tests/fixtures" "$WORK/p" >/dev/null
node "$HERE/requests.cjs" "$WORK/p" "$WORK"
for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$RESTPORT/" && break; sleep 1; done
export WORK RESTPORT PG
bash "$HERE/matrix.sh"
