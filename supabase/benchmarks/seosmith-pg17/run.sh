#!/usr/bin/env bash
# H01 receiver: native Postgres 17 migration dry-run and bounded scanner benchmark.
# Isolated: ephemeral podman container, tmpfs data, localhost-only port, synthetic data.
# Never connects to any hosted/production database.
#
# Usage: run.sh <htp-checkout-with-H01-migration> [N_SMALL_LEGACY=300]
set -euo pipefail
HTP=${1:?path to an HTP checkout containing the H01 migration}
N_SMALL=${2:-300}
IMAGE=${IMAGE:-public.ecr.aws/supabase/postgres:17.11.0.004}
NAME=htp-h01-dryrun-$$
PORT=${PORT:-55437}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
MIG=$HTP/supabase/migrations
H01=$(ls "$MIG" | grep versioned_receiver)
cleanup() { [ -n "${KEEP:-}" ] && { echo "kept container $NAME"; return; }; podman rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

echo "# htp head: $(git -C "$HTP" rev-parse HEAD)  H01 migration: $H01"
podman run -d --rm --name "$NAME" --memory 10g --shm-size 1g \
  --tmpfs /var/lib/postgresql/data:rw,size=6g -e POSTGRES_PASSWORD=dryrun \
  -p 127.0.0.1:$PORT:5432 "$IMAGE" >/dev/null
psql_as() { local u=$1; shift; podman exec -i -e PGPASSWORD=dryrun "$NAME" psql -v ON_ERROR_STOP=1 -q -U "$u" -h 127.0.0.1 -d postgres "$@"; }
for _ in $(seq 1 60); do psql_as supabase_admin -Atc 'select 1' >/dev/null 2>&1 && break; sleep 2; done
sleep 3
psql_as supabase_admin -Atc 'select version()'

# gotrue normally provides auth.jwt(); shim it exactly as the repo test harness does.
psql_as supabase_admin <<'SQL'
create or replace function auth.jwt() returns jsonb language sql stable as
$$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create schema dry;
create table dry.payloads(name text primary key, raw text not null);
create table dry.results(seq serial, phase text, label text, ms numeric, ok boolean, detail text);
create function dry.timeit(p_phase text, p_label text, p_role text, p_sql text, p_timeout text default '180s')
returns void language plpgsql as $f$
declare t0 timestamptz; ok boolean := true; detail text := ''; out text;
begin
  perform set_config('statement_timeout', p_timeout, true);
  t0 := clock_timestamp();
  begin
    execute format('set local role %I', p_role);
    execute p_sql into out;
    detail := left(coalesce(out,''), 160);
  exception when others then ok := false; detail := sqlstate || ' ' || left(sqlerrm, 140);
  end;
  reset role;
  insert into dry.results(phase,label,ms,ok,detail)
    values(p_phase,p_label,round(extract(epoch from clock_timestamp()-t0)*1000,1),ok,detail);
end $f$;
grant usage on schema dry to anon, authenticated; grant select on dry.payloads to anon, authenticated;
SQL

echo "# applying pre-H01 migrations"
for f in $(ls "$MIG" | grep -vE "versioned_receiver|seosmith_summary_target_lookup"); do
  psql_as postgres -1 -f - < "$MIG/$f" >/dev/null 2>"$WORK/err" || { echo "FAILED $f"; cat "$WORK/err"; exit 1; }
done

echo "# generating synthetic payloads"
mkdir -p "$WORK/p"
node "$HERE/gen.mjs" "$HTP/supabase/tests/fixtures" "$WORK/p" "$N_SMALL"
podman cp "$WORK/p" "$NAME":/tmp/p >/dev/null
podman exec -u 0 "$NAME" chmod -R a+rX /tmp/p
( echo "insert into dry.payloads(name,raw) values"
  first=1; for f in "$WORK"/p/*.json; do b=$(basename "$f" .json)
    [ $first = 1 ] && first=0 || echo ","
    printf "('%s', pg_read_file('/tmp/p/%s.json'))" "$b" "$b"; done; echo ";" ) | psql_as supabase_admin

SITE=00000000-0000-4000-8000-000000000002
OWNER=00000000-0000-4000-8000-0000000000aa
TOKEN=$(printf 'x%.0s' $(seq 1 64))
psql_as supabase_admin <<SQL
insert into auth.users(id) values('$OWNER');
insert into public.websites(id,owner_id,fqdn) values('$SITE','$OWNER','example.com');
insert into public.seosmith_bindings(website_id,token_sha256) values('$SITE',encode(sha256(convert_to('$TOKEN','UTF8')),'hex'));
SQL
INGEST="select public.ingest_seosmith_audit('$TOKEN',(raw::jsonb#>>'{request,request_id}')::uuid,encode(sha256(convert_to(raw,'UTF8')),'hex'),raw)::text from dry.payloads where name="
CLAIMS="select set_config('request.jwt.claims','{\"sub\":\"$OWNER\",\"is_anonymous\":false}',true); select set_config('request.jwt.claim.sub','$OWNER',true);"
HISTORY="select (public.seosmith_audit_history('$SITE',50)->'items')::text"

phase_ingest() { # $1 phase, rest: payload names
  local ph=$1; shift
  for n in "$@"; do
    psql_as supabase_admin -c "begin; select dry.timeit('$ph','ingest $n','anon',\$q\$$INGEST'$n'\$q\$); commit;" >/dev/null
  done
}

echo "# seeding legacy rows on the pre-H01 receiver"
psql_as supabase_admin >/dev/null <<SQL
begin; select dry.timeit('pre','seed $N_SMALL small legacy (worker path)','anon',
 \$q\$select count(public.ingest_seosmith_audit('$TOKEN',(raw::jsonb#>>'{request,request_id}')::uuid,encode(sha256(convert_to(raw,'UTF8')),'hex'),raw))::text from dry.payloads where name like 'legacy-small-%'\$q\$,'600s'); commit;
SQL
phase_ingest pre legacy-pages-1m legacy-pages-2m legacy-pages-4m legacy-pages-8m legacy-pad-16m legacy-pre-v2
psql_as supabase_admin -Atc "begin; $CLAIMS set local role authenticated; select 'auth debug uid='||coalesce(auth.uid()::text,'NULL')||' jwt='||auth.jwt()::text||' site_visible='||(select count(*) from public.websites); commit;" | grep debug
psql_as supabase_admin -c "begin; $CLAIMS select dry.timeit('pre','history read (50)','authenticated',\$q\$$HISTORY\$q\$); commit;" >/dev/null
psql_as supabase_admin -Atc "select 'pre rows='||count(*)||' raw_bytes='||sum(octet_length(raw_report_json))||' v4_summaries='||count(*) filter (where summary->>'summary_version'='4') from public.seosmith_audits"
BEFORE=$(psql_as supabase_admin -Atc "select md5(string_agg(delivery_id::text||sha256||md5(raw_report_json)||md5(report::text)||md5(summary::text),'' order by delivery_id)) from public.seosmith_audits")

echo "# applying H01 migration (single transaction, timed)"
T0=$(date +%s%N)
psql_as postgres -1 -f - < "$MIG/$H01" >/dev/null 2>"$WORK/err" || { echo "H01 MIGRATION FAILED"; cat "$WORK/err"; exit 1; }
T1=$(date +%s%N)
echo "H01 migration wall ms: $(( (T1-T0)/1000000 ))"
AFTER=$(psql_as supabase_admin -Atc "select md5(string_agg(delivery_id::text||sha256||md5(raw_report_json)||md5(report::text)||md5(summary::text),'' order by delivery_id)) from public.seosmith_audits")
[ "$BEFORE" = "$AFTER" ] && echo "immutable source rows: UNCHANGED ($AFTER)" || { echo "SOURCE ROWS CHANGED"; exit 1; }
psql_as supabase_admin -At <<'SQL'
select 'cache rows='||count(*)||' derivation_failed='||count(*) filter (where summary->>'summary_derivation_failed'='true')
  ||' uncached_pre_v4='||(select count(*) from public.seosmith_audits a where a.summary->>'summary_version' is distinct from '4'
      and not exists(select 1 from public.seosmith_summary_cache c where c.delivery_id=a.delivery_id and c.summary_version=4))
  ||' cache_size='||pg_size_pretty(pg_total_relation_size('public.seosmith_summary_cache'))
  ||' audits_size='||pg_size_pretty(pg_total_relation_size('public.seosmith_audits')) from public.seosmith_summary_cache;
select 'capabilities='||public.seosmith_receiver_capabilities()::text;
SQL

echo "# post-H01 checks"
psql_as supabase_admin -c "begin; $CLAIMS select dry.timeit('post','history read (50)','authenticated',\$q\$$HISTORY\$q\$); commit;" >/dev/null
# idempotent retry of already-stored legacy bytes, then new legacy and v2 deliveries
phase_ingest post-retry legacy-pages-8m legacy-pad-16m
phase_ingest post legacy-post-small legacy-post-8m v2-complete v2-partial v2-truncated v2-oversize
psql_as supabase_admin -c "begin; $CLAIMS select dry.timeit('post','owner import v2-complete-import','authenticated',\$q\$select public.import_seosmith_audit('$SITE',raw)::text from dry.payloads where name='v2-complete-import'\$q\$); commit;" >/dev/null
for n in scan-legacy-tokens-16m scan-v2-tokens-16m scan-v2-strings-16m scan-v2-deep-contiguous scan-v2-deep-late scan-v2-deep-sparse scan-v2-dup-late scan-v2-escaped-version; do
  psql_as supabase_admin -c "begin; select dry.timeit('scan','$n','supabase_admin',\$q\$select public.seosmith_check_raw_report(raw)::text from dry.payloads where name='$n'\$q\$,'300s'); commit;" >/dev/null
done
psql_as supabase_admin -Atc "select 'post rows='||count(*)||' schema2='||count(*) filter (where report->>'schema_version'='2') from public.seosmith_audits"
echo "# results (phase | label | ms | ok | detail)"
psql_as supabase_admin -At -F ' | ' -c "select phase,label,ms,ok,detail from dry.results order by seq"

# Apply the reviewed candidate after the baseline, then exercise the same paths.
echo "# installing candidate migration"
psql_as postgres -1 -f - < "$MIG/20261116221958_seosmith_summary_target_lookup.sql"
echo "# candidate path timings and byte check"
psql_as supabase_admin -f - < "$HERE/candidate.sql"
