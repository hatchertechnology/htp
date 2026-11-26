#!/usr/bin/env bash
# S14 schema-4 admission: native PG17 replay + commit check + N-M3 commit timing.
#
#   scripts/s14-schema4-native/run.sh --order prod|lexical <htp-h1-checkout> [--exact-cap-report F --exact-cap-summary F]
#
# --order prod    = main positions 1-45, 51-55, 46-50 (the production ledger order), then
#                   every migration at or after 20261211000000.
# --order lexical = a fresh install (plain lexical order).
# The disposable container has no network and is always removed. Nothing here touches a
# hosted database. <htp-h1-checkout> supplies crates/s14-receiver (the real `admit`).
#
# Copied from the e2e runner 99139938:scripts/s14-receipt-e2e/run.sh (container, readiness,
# psql wiring), with the proof/receipt prototype replaced by the schema-4 admission path.
# The N-M3 timing runs the container at --cpus 0.2 --memory 1g (the record's local clone
# size, wave1-lifecycle-enable-nov25.md:57-58; a stand-in, production hardware is unknown).
set -euo pipefail
cd "$(dirname "$0")/../.."
root="$PWD"

order=""; h1=""; cap_report=""; cap_summary=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --order) order="$2"; shift 2 ;;
    --exact-cap-report) cap_report="$2"; shift 2 ;;
    --exact-cap-summary) cap_summary="$2"; shift 2 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) h1="$1"; shift ;;
  esac
done
[[ "$order" == prod || "$order" == lexical ]] || { echo "usage: $0 --order prod|lexical <htp-h1-checkout>" >&2; exit 2; }
[[ -d "$h1/crates/s14-receiver" ]] || { echo "H1 checkout with crates/s14-receiver required" >&2; exit 2; }

MIG_DIR="${S14_MIGRATIONS_DIR:-$root/supabase/migrations}"
PG_IMAGE="${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.11.0.004}"
TARGET="${S14_TARGET_DIR:-/var/tmp/s14-schema4-native-target}"
FIRST_NEW="20261211000000"
PENDING=(20261202000000_seosmith_remediation.sql 20261203000000_audit_event_queue.sql 20261203000001_audit_operational_hooks.sql 20261204000000_search_bounded_dataset.sql 20261205000000_comparison_pilot_scope.sql)
RUNS="${S14_TIMING_RUNS:-5}"
LIMIT_MS=10000

pg="s14-schema4-native-$$"
tmp="$(mktemp -d "${TMPDIR:-/var/tmp}/s14-schema4-native.XXXXXXXX")"
cleanup() { local rc=$?; trap - EXIT; podman rm -f --volumes "$pg" >/dev/null 2>&1 || true; rm -rf "$tmp"; exit "$rc"; }
trap cleanup EXIT

# --- migration order -----------------------------------------------------------
mapfile -t all < <(cd "$MIG_DIR" && ls *.sql | sort)
base=(); new=(); pend=()
for f in "${all[@]}"; do
  v="${f%%_*}"
  if [[ "$v" > "$FIRST_NEW" || "$v" == "$FIRST_NEW" ]]; then new+=("$f")
  elif printf '%s\n' "${PENDING[@]}" | grep -qx "$f"; then pend+=("$f")
  else base+=("$f"); fi
done
[[ ${#pend[@]} -eq 5 ]] || { echo "expected the 5 pending migrations, found ${#pend[@]}" >&2; exit 1; }
[[ ${#new[@]} -ge 1 && "${new[0]%%_*}" == "$FIRST_NEW" ]] || { echo "H2 migration missing" >&2; exit 1; }
if [[ "$order" == prod ]]; then seq=("${base[@]}" "${pend[@]}" "${new[@]}"); else seq=("${all[@]}"); fi
echo "== order=$order: ${#base[@]} base + ${#pend[@]} pending + ${#new[@]} new = ${#seq[@]} migrations (head $(git -C "$root" rev-parse --short HEAD))"

# --- real receiver summary for the genuine pairing --------------------------------
fixture_rel="crates/s14-receiver/tests/fixtures/v4-candidate-complete.json"
echo "== building the receiver admit example from $h1 ($(git -C "$h1" rev-parse --short HEAD))"
( cd "$h1" && TMPDIR=/var/tmp CARGO_TARGET_DIR="$TARGET" cargo build --offline --locked --release -p htp-s14-receiver --example admit -j2 ) >"$tmp/build.log" 2>&1 \
  || { cat "$tmp/build.log" >&2; exit 1; }
admit="$TARGET/release/examples/admit"
rev_expected="$(grep -o 's14-wire-1/full-population-1/evidence-v1' "$MIG_DIR/20261211000000_s14_schema4_admission.sql" | head -1)"
"$admit" "$h1/$fixture_rel" >"$tmp/summary.json" 2>"$tmp/admit.err"
cp "$h1/$fixture_rel" "$tmp/raw.json"
grep -q "validator_revision=$rev_expected " "$tmp/admit.err" || { echo "receiver revision != migration seed ($rev_expected)" >&2; cat "$tmp/admit.err" >&2; exit 1; }
summary_sha="$(sha256sum "$tmp/summary.json" | cut -d' ' -f1)"
grep -q "sha256=sha256:$summary_sha " "$tmp/admit.err" || { echo "summary bytes != receiver-reported digest" >&2; exit 1; }
raw_sha="$(sha256sum "$tmp/raw.json" | cut -d' ' -f1)"
req_id="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).request.request_id)' "$tmp/raw.json")"
site_id="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).request.website_id)' "$tmp/raw.json")"

# --- exact-cap timing fixture (synthetic until S2's exists) -------------------------
mkdir -p "$tmp/cap"
cap_id="00000000-0000-4000-8000-0000000000c1"; cap_site="00000000-0000-4000-8000-0000000000c2"; cap_kind="synthetic exact-cap (gen.mjs)"
if [[ -n "$cap_report" ]]; then
  cp "$cap_report" "$tmp/cap/report.json"; cp "$cap_summary" "$tmp/cap/summary.json"
  cap_id="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).request.request_id)' "$tmp/cap/report.json")"
  cap_site="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).request.website_id)' "$tmp/cap/report.json")"
  cap_kind="supplied fixture"
else
  node scripts/s14-schema4-native/gen.mjs "$tmp/cap" "$cap_id" "$cap_site" 1 2>"$tmp/gen.err"; cat "$tmp/gen.err"
fi
cap_bytes="$(wc -c <"$tmp/cap/report.json" | tr -d ' ')"
echo "== timing fixture: $cap_kind, $cap_bytes bytes"

# --- disposable network-none PG17 -------------------------------------------------
echo "== starting disposable network-none PG17 ($PG_IMAGE)"
podman run --pull=never -d --name "$pg" --network none -e POSTGRES_PASSWORD=fixture-only "$PG_IMAGE" postgres -D /var/lib/postgresql/data >/dev/null
init_done=false
for _ in $(seq 1 120); do podman logs "$pg" 2>&1 | grep -q 'PostgreSQL init process complete' && { init_done=true; break; }; sleep 1; done
[[ "$init_done" == true ]] || { podman logs "$pg" >&2; exit 1; }
for _ in $(seq 1 60); do podman exec "$pg" pg_isready -U supabase_admin -d postgres >/dev/null 2>&1 && podman exec "$pg" psql -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
adm() { podman exec -i "$pg" psql -U supabase_admin -d postgres -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
mig() { podman exec -i "$pg" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1; }
adm >/dev/null <<'SQL'
create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
grant execute on function auth.jwt(),auth.uid() to public;
SQL

echo "== applying ${#seq[@]} migrations ($order order)"
for f in "${seq[@]}"; do
  mig <"$MIG_DIR/$f" >"$tmp/mig.out" 2>&1 || { echo "MIGRATION FAILED: $f" >&2; cat "$tmp/mig.out" >&2; exit 1; }
done
ledger_md5="$(printf '%s\n' "${seq[@]%%_*}" | sort | md5sum | cut -d' ' -f1)"
echo "applied ${#seq[@]} migrations; sorted-version md5 $ledger_md5"

# --- fixtures into the container ---------------------------------------------------
podman exec "$pg" mkdir -p /tmp/s4 >/dev/null
podman cp "$tmp/raw.json" "$pg:/tmp/s4/raw.json"; podman cp "$tmp/summary.json" "$pg:/tmp/s4/summary.json"
podman cp "$tmp/cap/report.json" "$pg:/tmp/s4/cap-report.json"; podman cp "$tmp/cap/summary.json" "$pg:/tmp/s4/cap-summary.json"
podman exec -u 0 "$pg" chmod -R a+rX /tmp/s4

token="native-worker-token-0000000000000000000000000001"
owner="00000000-0000-4000-8000-0000000000aa"; nonowner="00000000-0000-4000-8000-0000000000bb"
rev="$rev_expected"
tok_sha="$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)"
cap_token="native-worker-token-0000000000000000000000000002"
cap_tok_sha="$(printf '%s' "$cap_token" | sha256sum | cut -d' ' -f1)"
adm >/dev/null <<SQL
insert into auth.users(id) values ('$owner'),('$nonowner'),('00000000-0000-4000-8000-0000000000cc') on conflict do nothing;
insert into public.websites(id,owner_id,fqdn) values ('$site_id','$owner','example.com'),('$cap_site','00000000-0000-4000-8000-0000000000cc','example.com');
insert into public.seosmith_bindings(website_id,token_sha256) values ('$site_id','$tok_sha'),('$cap_site','$cap_tok_sha');
SQL

fail() { echo "FAIL: $*" >&2; exit 1; }
expect_err() { # expect_err <regex> <sql>
  local out; if out="$(adm -c "$2" 2>&1)"; then fail "expected error /$1/ but succeeded: $2"; fi
  grep -Eq "$1" <<<"$out" || fail "error did not match /$1/: $out"
}

echo "== ACLs"
expect_err 'permission denied' "set role anon; select public.commit_seosmith_audit_v4('$token','$req_id','x','x','x','x')"
expect_err 'permission denied' "set role authenticated; select public.commit_seosmith_audit_v4('$token','$req_id','x','x','x','x')"
[[ "$(adm -c "select has_function_privilege('service_role','public.commit_seosmith_audit_v4(text,uuid,text,text,text,text)','execute')")" == t ]] || fail "service_role cannot execute"

echo "== genuine receiver pairing commits as service_role"
cat >"$tmp/commit.sql" <<SQL
select pg_read_file('/tmp/s4/raw.json') as raw, pg_read_file('/tmp/s4/summary.json') as summary \gset
set role service_role;
select public.commit_seosmith_audit_v4('$token','$req_id',encode(sha256(convert_to(:'raw','UTF8')),'hex'),:'raw',:'summary','$rev');
select public.commit_seosmith_audit_v4('$token','$req_id',encode(sha256(convert_to(:'raw','UTF8')),'hex'),:'raw',:'summary','$rev');
SQL
receipts="$(adm <"$tmp/commit.sql")"
node -e 'const [a,b]=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse);const w={delivery_id:process.argv[1],sha256:process.argv[2],accepted:true};const ok=x=>Object.keys(x).sort().join()=="accepted,delivery_id,sha256"&&x.delivery_id==w.delivery_id&&x.sha256==w.sha256&&x.accepted===true;process.exit(ok(a)&&ok(b)?0:1)' "$req_id" "$raw_sha" <<<"$receipts" || fail "receipt mismatch: $receipts"
[[ "$(adm -c "select count(*) from public.seosmith_audits where delivery_id='$req_id'")" == 1 ]] || fail "expected exactly one row"
row="$(adm -c "select sha256||' '||summary_sha256||' '||validator_revision||' '||octet_length(raw_report_json)||' '||octet_length(summary_text)||' '||ingestion_source from public.seosmith_audits where delivery_id='$req_id'")"
[[ "$row" == "$raw_sha $summary_sha $rev $(wc -c <"$tmp/raw.json" | tr -d ' ') $(wc -c <"$tmp/summary.json" | tr -d ' ') worker" ]] || fail "stored row mismatch: $row"
cat >"$tmp/conflict.sql" <<SQL
select pg_read_file('/tmp/s4/raw.json')||' ' as raw, pg_read_file('/tmp/s4/summary.json') as summary \\gset
set role service_role;
select public.commit_seosmith_audit_v4('$token','$req_id',encode(sha256(convert_to(:'raw','UTF8')),'hex'),:'raw',:'summary','$rev');
SQL
if out="$(adm <"$tmp/conflict.sql" 2>&1)"; then fail "a byte change on a committed id was accepted"; fi
grep -q 'delivery_conflict' <<<"$out" || fail "byte change did not conflict: $out"

echo "== owner detail compare, non-owner denied"
cat >"$tmp/detail.sql" <<SQL
select pg_read_file('/tmp/s4/raw.json') as raw, pg_read_file('/tmp/s4/summary.json') as summary \gset
set role authenticated;
select set_config('request.jwt.claims','{"sub":"$owner","is_anonymous":false}',false);
select (d->>'summary_text'=:'summary') and (d->>'report_json'=:'raw') and (d->>'source_sha256'='$raw_sha')
  and (d->>'summary_sha256'='$summary_sha') and (d->>'source_bytes')::int=octet_length(:'raw')
  and (d->>'summary_bytes')::int=octet_length(:'summary') and (d->'summary'->>'summary_version')='5' as cmp
  from (select public.seosmith_audit_detail('$site_id','$req_id') d) q;
SQL
[[ "$(adm <"$tmp/detail.sql" | tail -1)" == t ]] || fail "owner detail cmp is not true"
expect_err 'forbidden' "set role authenticated; select set_config('request.jwt.claims','{\"sub\":\"$nonowner\",\"is_anonymous\":false}',false); select public.seosmith_audit_detail('$site_id','$req_id')"
[[ "$(adm -c "select public.seosmith_receiver_capabilities()->'schema_versions'")" == '[1, 2, 4]' ]] || fail "capability"

echo "== N-M3 commit timing: --cpus 0.2 --memory 1g, lifecycle trigger enabled, $RUNS runs"
trig="$(adm -c "select tgenabled from pg_trigger where tgrelid='public.seosmith_audits'::regclass and tgname='seosmith_lifecycle_index_after_insert'")"
[[ "$trig" == O ]] || fail "lifecycle trigger not enabled ($trig)"
podman update --cpus 0.2 --memory 1g --memory-swap 1g "$pg" >/dev/null 2>&1 || echo "note: podman update unavailable; timing ran unthrottled" >&2
echo "container limits: $(podman inspect "$pg" --format 'cpus={{.HostConfig.NanoCpus}}ns memory={{.HostConfig.Memory}}')"
adm >/dev/null <<SQL
create schema bench; create table bench.results(run int, stage text, ms numeric);
create table bench.p(raw text, sha text, summary text);
grant usage on schema bench to service_role; grant all on bench.results to service_role; grant select on bench.p to service_role;
SQL
for i in $(seq 1 "$RUNS"); do
  id="$(printf '00000000-0000-4000-8000-%012x' $((0xd000 + i)))"
  cat >"$tmp/time.sql" <<SQL
select pg_read_file('/tmp/s4/cap-report.json') as raw, pg_read_file('/tmp/s4/cap-summary.json') as summary \gset
select replace(:'raw','$cap_id','$id') as raw \gset
select encode(sha256(convert_to(:'raw','UTF8')),'hex') as sha \gset
truncate bench.p; insert into bench.p values (:'raw', :'sha', :'summary');
-- stages measured standalone (as the owner role), then the real RPC as service_role
do \$\$ declare t timestamptz; r jsonb; raw text; compact jsonb; ms numeric; c record;
begin
  select p.raw into raw from bench.p p;
  t:=clock_timestamp(); perform encode(sha256(convert_to(raw,'UTF8')),'hex');
  insert into bench.results values ($i,'raw sha256',extract(epoch from clock_timestamp()-t)*1000);
  t:=clock_timestamp(); r:=raw::jsonb;
  insert into bench.results values ($i,'raw::jsonb',extract(epoch from clock_timestamp()-t)*1000);
  t:=clock_timestamp(); perform r is distinct from raw::jsonb;
  insert into bench.results values ($i,'raw/report equality',extract(epoch from clock_timestamp()-t)*1000);
  t:=clock_timestamp();
  select jsonb_set(jsonb_object_agg(k, r->k),'{schema_version}','2'::jsonb) into compact from unnest(array['schema_version','pages','findings','request','outcome','started_at','finished_at','engine_version','ruleset_version','stop_reason','coverage_complete','evidence_contract']) k where r ? k;
  perform public.seosmith_validate_evidence(compact);
  insert into bench.results values ($i,'evidence validation',extract(epoch from clock_timestamp()-t)*1000);
end \$\$;
set role service_role;
do \$\$ declare t timestamptz; p bench.p; begin
  select * into p from bench.p;
  t:=clock_timestamp();
  perform public.commit_seosmith_audit_v4('$cap_token','$id',p.sha,p.raw,p.summary,'$rev');
  insert into bench.results values ($i,'commit (total)',extract(epoch from clock_timestamp()-t)*1000);
end \$\$;
reset role;
delete from public.seosmith_lifecycle_indexed where delivery_id='$id';
do \$\$ declare t timestamptz; begin
  t:=clock_timestamp(); perform public.seosmith_index_lifecycle('$id');
  insert into bench.results values ($i,'lifecycle trigger',extract(epoch from clock_timestamp()-t)*1000);
end \$\$;
SQL
  adm <"$tmp/time.sql" >/dev/null || { echo "timing run $i failed" >&2; exit 1; }
done
[[ "$(adm -c "select count(*) from public.seosmith_audits where delivery_id::text like '00000000-0000-4000-8000-00000000d00%'")" == "$RUNS" ]] || fail "timing commits not stored"
echo "stage                   p50 ms      max ms"
adm -F' ' -c "select rpad(stage,22), lpad(round((percentile_cont(0.5) within group (order by ms))::numeric,1)::text,10), lpad(round(max(ms),1)::text,10) from bench.results group by stage order by min(case stage when 'raw sha256' then 1 when 'raw::jsonb' then 2 when 'raw/report equality' then 3 when 'evidence validation' then 4 when 'commit (total)' then 5 else 6 end)"
max_ms="$(adm -c "select round(max(ms)) from bench.results where stage='commit (total)'")"
echo "commit max ${max_ms} ms (limit ${LIMIT_MS} ms) on $cap_kind ($cap_bytes bytes, $(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.evidence_contract.evaluations.length+" evaluations, "+r.evidence_contract.observations.length+" observations")' "$tmp/cap/report.json"))"
(( max_ms <= LIMIT_MS )) || fail "commit max ${max_ms} ms exceeds ${LIMIT_MS} ms"
echo "S14-SCHEMA4-NATIVE: PASS"
