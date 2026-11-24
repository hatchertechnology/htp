#!/usr/bin/env bash
# Disposable local PG17/PostgREST/API stack for the bounded Search dataset read.
# Synthetic identities and synthetic saved snapshots only; no hosted service.
set -euo pipefail
cd "$(dirname "$0")/../.."
pg="search-bounded-pg-$$"; rest="search-bounded-rest-$$"; tmp=$(mktemp -d "$PWD/.search-bounded-native.XXXXXXXX"); export FIXTURE_DIR="$tmp" TMPDIR="$tmp"
cleanup() {
  local rc=$?
  trap - EXIT
  for pid in ${apipid:-} ${issuerpid:-}; do
    kill "$pid" 2>/dev/null || :
    wait "$pid" 2>/dev/null || :
  done
  # PostgREST shares the database container's network namespace.
  podman rm --ignore --force --volumes "$rest" >/dev/null || rc=1
  podman rm --ignore --force --volumes "$pg" >/dev/null || rc=1
  rm -rf "$tmp"
  exit "$rc"
}
trap cleanup EXIT
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
export ISSUER_PORT=$(free_port) API_PORT=$(free_port)
podman run --pull=never -d --name "$pg" -e POSTGRES_PASSWORD=fixture-only -p 127.0.0.1::3000 public.ecr.aws/supabase/postgres@sha256:b15d862126dd2dac02da524696ccfde2dcce2ceaee0a58973b2727befe492706 postgres -D /var/lib/postgresql/data >/dev/null
ready=false; for i in {1..60}; do if podman logs "$pg" 2>&1 | grep -q 'PostgreSQL init process complete' && podman exec "$pg" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done; $ready
psqlc() { podman exec -i "$pg" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
psqlc <<'SQL'
create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
grant execute on function auth.jwt(),auth.uid() to public;
SQL
# The full additive chain; this fixture exercises the real ordered migrations.
for f in $(ls supabase/migrations/*.sql | sort); do psqlc < "$f"; done
psqlc <<'SQL'
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into public.websites(id,owner_id,fqdn,ga4_property_id) values
  ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','www.example.com','123');
insert into public.google_connections(owner_id,encrypted_grant,scopes,status) values
  ('00000000-0000-0000-0000-000000000001','fixture','{}','disconnected');
insert into public.google_report_jobs(id,website_id,fqdn,kind,property_id,start_date,end_date) values
  ('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000003','www.example.com','search','sc-domain:www.example.com','2026-10-01','2026-10-03'),
  ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000003','www.example.com','conversions','123','2026-10-01','2026-10-03'),
  ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000003','www.example.com','search','sc-domain:www.example.com','2026-09-01','2026-09-03');
insert into public.google_report_snapshots(job_id,data,fetched_at) values
  ('00000000-0000-0000-0000-000000000010', '{
    "site_url":"sc-domain:www.example.com","start_date":"2026-10-01","end_date":"2026-10-03",
    "queries":{"rows":[{"keys":["alpha"],"clicks":1,"impressions":10,"ctr":0.1,"position":1},
      {"keys":["beta"],"clicks":2,"impressions":20,"ctr":0.1,"position":2},
      {"keys":["gamma"],"clicks":3,"impressions":30,"ctr":0.1,"position":3}],
      "collection":{"dimensions":["query"],"returned_rows":3,"truncated":false,"anonymized_queries":"excluded","data_state":"final"}},
    "pages":{"rows":[{"keys":["https://www.example.com/"],"clicks":6,"impressions":60,"ctr":0.1,"position":2}],"collection":{"truncated":false}},
    "query_page_segments":{"rows":[
      {"keys":["alpha","https://www.example.com/","MOBILE","usa"],"clicks":1,"impressions":10,"ctr":0.1,"position":1},
      {"keys":["malformed"]},
      {"keys":["alpha","https://www.example.com/","MOBILE","usa"],"clicks":2,"impressions":20,"ctr":0.1,"position":2},
      {"keys":["alpha","https://www.example.com/","DESKTOP","usa"],"clicks":20,"impressions":200,"ctr":0.1,"position":20},
      {"foo":1},
      {"keys":["alpha","https://www.example.com/","MOBILE","can"],"clicks":30,"impressions":300,"ctr":0.1,"position":30},
      {"keys":["alpha","https://www.example.com/","MOBILE","usa"],"clicks":3,"impressions":30,"ctr":0.1,"position":3},
      {"keys":["alpha","https://www.example.com/","MOBILE","usa"],"clicks":4,"impressions":40,"ctr":0.1,"position":4},
      {"keys":["alpha","https://www.example.com/","MOBILE","usa"],"clicks":5,"impressions":50,"ctr":0.1,"position":5}],
      "collection":{"truncated":true,"anonymized_queries":"excluded"}},
    "analysis":{"candidates":[{"kind":"low_ctr_review","page":"https://www.example.com/","source":"search.pages","evidence":[{"keys":["https://www.example.com/"],"clicks":6},{"keys":["https://www.example.com/other"],"clicks":1}],"interpretation":"review"}],
      "comparison":{"available":true,"reason":null},"coverage":{"scope":"retained_observations_only"},"policy":{"min_impressions":100},
      "landing_outcomes":{"available":true,"reason":null,"rows":[{"landing_page":"/sibling-a"},{"landing_page":"/sibling-b"}]}},
    "measurement":{"version":1,"source":"google_search_console","provider_completeness":"not_guaranteed","anonymized_queries":"excluded_from_query_dimensions"},
    "daily":{"rows":[{"keys":["2026-10-01"],"clicks":1,"impressions":10},{"keys":["2026-10-02"],"clicks":2,"impressions":20}]}
  }', now()),
  ('00000000-0000-0000-0000-000000000011', '{
    "analysis":{"landing_outcomes":{"available":true,"reason":null,"coverage":"bounded_provider_rows",
      "attribution":"All collected channels; no attribution to individual search queries.",
      "collection":{"row_count":2,"returned_rows":2,"truncated":false},
      "rows":[{"landing_page":"/a","metrics":{"sessions":1,"keyEvents":0,"totalRevenue":0,"sessionKeyEventRate":0},"evidence":{"dimensionValues":[{"value":"/a"}]}},
        {"landing_page":"/b","metrics":{"sessions":2,"keyEvents":1,"totalRevenue":5,"sessionKeyEventRate":0.5},"evidence":{"dimensionValues":[{"value":"/b"}]}}]}},
    "pages":{"metadata":{"currencyCode":"USD"}},
    "measurement":{"version":1,"provider_completeness":"not_guaranteed"}
  }', now()),
  ('00000000-0000-0000-0000-000000000012', '{"queries":{"rows":[{"keys":["legacy"],"clicks":1}]},"query_page_segments":{"unavailable":true,"reason":"segment_collection_unavailable","rows":[]}}', now());
SQL
port=$(podman port "$pg" 3000/tcp | sed -n 's/^127\.0\.0\.1:\([0-9]*\)$/\1/p'); [[ "$port" =~ ^[0-9]+$ ]]; export FIXTURE_REST="http://127.0.0.1:$port"
node scripts/remediation-native/issuer.mjs >"$tmp/issuer.log" 2>&1 & issuerpid=$!
for i in {1..30}; do [[ -f "$tmp/jwks.json" ]] && break; sleep 1; done
podman run --pull=never -d --name "$rest" --network "container:$pg" -e PGRST_DB_URI=postgres://authenticator:fixture-only@127.0.0.1:5432/postgres -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e "PGRST_JWT_SECRET=$(cat "$tmp/jwks.json")" public.ecr.aws/supabase/postgrest@sha256:c847127074bd26e1b8d3f7c0e6e01e5346f4b85dd34f5d699fd230af960827c0 >/dev/null
ready=false; for i in {1..30}; do if curl -fsS "$FIXTURE_REST/" >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done; $ready || { podman logs "$rest" >&2; exit 1; }
SUPABASE_URL="http://127.0.0.1:$ISSUER_PORT" SUPABASE_PUBLISHABLE_KEY=fixture HTP_ROLLOUT_SEARCH_EVIDENCE=true BIND_ADDR="127.0.0.1:$API_PORT" target/debug/htp-api >"$tmp/api.log" 2>&1 & apipid=$!
ready=false; for i in {1..30}; do if curl -fsS "http://127.0.0.1:$API_PORT/" >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done; $ready || { cat "$tmp/api.log" >&2; exit 1; }
node scripts/search-bounded-native/check.mjs || { cat "$tmp/api.log" >&2; exit 1; }
