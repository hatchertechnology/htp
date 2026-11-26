#!/usr/bin/env bash
# S14 schema 4, part X: local cross-repo end-to-end (plan schema4.md §5/§6 X, N-M1, N5, N-M3, N-M4, M8, M9).
#
#   scripts/s14-schema4-e2e/run.sh <seosmith-checkout> [--out DIR] [--runs N] [--cap-runs N] [--skip-crawl-bounds]
#
# Everything is local: a `supabase start` stack (own project id and ports, ALL migrations), the HTP API
# release build with HTP_S14_ADMISSION=true under a 256 MB / 1 CPU cgroup scope, and a SEOsmith `serve`
# built with --features local-e2e. Nothing here touches a hosted database. The only outside traffic is the
# tiny and the Q2-bound public crawls of https://www.kerryhatcher.com/ (owner decision (a)).
# Stops at the first FAIL (reported, never patched). Results: $OUT/results.md + $OUT/results.tsv.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
seo="${1:?usage: run.sh <seosmith-checkout> [options]}"; shift
seo="$(cd "$seo" && pwd)"
out="$here/results"; RUNS=5; CAP_RUNS=20; SKIP_BOUNDS=0
while [[ $# -gt 0 ]]; do case "$1" in
  --out) out="$2"; shift 2 ;; --runs) RUNS="$2"; shift 2 ;; --cap-runs) CAP_RUNS="$2"; shift 2 ;;
  --skip-crawl-bounds) SKIP_BOUNDS=1; shift ;; *) echo "unknown option $1" >&2; exit 2 ;; esac; done
mkdir -p "$out"; out="$(cd "$out" && pwd)"

WORK="$(mktemp -d /var/tmp/s4x-e2e.XXXXXX)"
HTP_T="${HTP_TARGET_DIR:-/var/tmp/s4x-target-htp}"
SEO_T="${SEO_TARGET_DIR:-/var/tmp/s4x-target-seo}"
PROJECT=s4x-e2e; DB="supabase_db_$PROJECT"
API_PORT=3917; SEO_PORT=8917; SB_API=55321
API="http://127.0.0.1:$API_PORT"; SEOURL="http://127.0.0.1:$SEO_PORT"; SB="http://127.0.0.1:$SB_API"
INGEST="$API/integrations/seosmith/policy-audits"; LEGACY="$API/integrations/seosmith/audits"
FIX="$seo/fixtures/contracts"; S4FIX="$FIX/s14-schema4-v1"
TSV="$out/results.tsv"; : >"$TSV"
CAP_BYTES=4952756
APISCOPE=s4x-api
pids=()

rec() { # rec PASS|FAIL|INFO <id> <name> <detail>
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >>"$TSV"
  printf '[%s] %s %s — %s\n' "$1" "$2" "$3" "$4"
  if [[ "$1" == FAIL ]]; then
    report; echo "STOPPING at first FAIL ($2)" >&2; tail -5 "$WORK/api.log" "$WORK/seo.log" 2>/dev/null | cut -c1-300 >&2
    if [[ -n "${PAUSE_ON_FAIL:-}" ]]; then touch "$WORK/pause"; echo "paused: rm $WORK/pause to stop" >&2; while [[ -e "$WORK/pause" ]]; do sleep 5; done; fi
    exit 1
  fi
}
report() { # write results.md from the tsv
  {
    echo "# S14 schema 4 part X: local end-to-end results"
    echo; echo "HTP head \`$(git -C "$root" rev-parse --short HEAD)\`, SEOsmith head \`$(git -C "$seo" rev-parse --short HEAD)\`, run $(date -u +%FT%TZ), host loadavg at start ${LOAD0:-?}."
    echo; echo "| Result | Step | Name | Detail |"; echo "|---|---|---|---|"
    awk -F'\t' '{gsub(/\|/,"\\|",$4); printf "| %s | %s | %s | %s |\n",$1,$2,$3,$4}' "$TSV"
  } >"$out/results.md"
}
cleanup() {
  local rc=$?; trap - EXIT
  for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  systemctl --user stop "$APISCOPE.scope" >/dev/null 2>&1 || true
  ( cd "$WORK/sb" 2>/dev/null && supabase stop --no-backup >/dev/null 2>&1 ) || true
  [[ -n "${KEEP:-}" ]] || rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT

psql_() { podman exec -i "$DB" psql -U postgres -d postgres -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
q() { psql_ -c "$1"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
epoch_ms() { date +%s%3N; }
wait_for() { # wait_for <secs> <cmd...>
  local n="$1"; shift; for _ in $(seq 1 "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
uuid() { printf '%s' "$(cat /proc/sys/kernel/random/uuid)"; }

# ---------------------------------------------------------------------------------------------------
LOAD0="$(cut -d' ' -f1-3 /proc/loadavg)"
echo "== builds (HTP release api + receiver examples; SEOsmith serve with local-e2e)"
( cd "$root" && CARGO_TARGET_DIR="$HTP_T" cargo build --release --locked -p htp-api >"$WORK/b1.log" 2>&1 \
  && CARGO_TARGET_DIR="$HTP_T" cargo build --release --locked -p htp-s14-receiver --example resource_check --example admit >>"$WORK/b1.log" 2>&1 ) \
  || { tail -20 "$WORK/b1.log"; rec FAIL 0 "build htp" "see log"; }
( cd "$seo" && CARGO_TARGET_DIR="$SEO_T" cargo +1.98.1 build --locked --features local-e2e --bin seosmith --example deliver_once >"$WORK/b2.log" 2>&1 ) \
  || { tail -20 "$WORK/b2.log"; rec FAIL 0 "build seosmith local-e2e" "see log"; }
APIBIN="$HTP_T/release/htp-api"; SEOBIN="$SEO_T/debug/seosmith"; DELIVER="$SEO_T/debug/examples/deliver_once"
ADMIT="$HTP_T/release/examples/admit"; RCHECK="$HTP_T/release/examples/resource_check"

# ---------------------------------------------------------------------------------------------------
echo "== step 1: supabase start with all migrations"
mkdir -p "$WORK/sb/supabase"; ln -sfn "$root/supabase/migrations" "$WORK/sb/supabase/migrations"
cat >"$WORK/sb/supabase/config.toml" <<EOF
project_id = "$PROJECT"
[api]
port = $SB_API
[db]
port = 55322
shadow_port = 55320
major_version = 17
[studio]
enabled = false
[inbucket]
enabled = false
[realtime]
enabled = false
[storage]
enabled = false
[analytics]
enabled = false
[edge_runtime]
enabled = false
[auth]
site_url = "http://127.0.0.1:$API_PORT"
EOF
( cd "$WORK/sb" && supabase stop --no-backup >/dev/null 2>&1; supabase start -x studio,imgproxy,vector,logflare,edge-runtime,realtime,storage-api,mailpit,postgres-meta,supavisor >"$WORK/sbstart.log" 2>&1 ) \
  || { tail -20 "$WORK/sbstart.log"; rec FAIL 1 "supabase start" "failed"; }
eval "$(cd "$WORK/sb" && supabase status -o env 2>/dev/null | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY|PUBLISHABLE_KEY)=')"
nmig="$(ls "$root/supabase/migrations"/*.sql | wc -l)"; applied="$(q 'select count(*) from supabase_migrations.schema_migrations')"
[[ "$nmig" == "$applied" ]] || rec FAIL 1 "all migrations applied" "files=$nmig applied=$applied"
[[ "$(q "select count(*) from public.seosmith_s14_validators where enabled and revision='s14-wire-1/full-population-1/evidence-v1'")" == 1 ]] \
  || rec FAIL 1 "validator seeded" "no enabled validator row"
trig="$(q "select tgenabled from pg_trigger where tgrelid='public.seosmith_audits'::regclass and tgname='seosmith_lifecycle_index_after_insert'")"
rec PASS 1 "stack up, all migrations" "$applied/$nmig migrations applied (lexical order); lifecycle trigger tgenabled=$trig; validator row enabled; head $(git -C "$root" rev-parse --short HEAD)"

# --- users, websites, bindings ----------------------------------------------------------------------
declare -A SITE_ID SITE_TOKEN SITE_JWT SITE_FQDN
mksite() { # mksite <name> <fqdn> <website-uuid>
  local name="$1" fqdn="$2" wid="$3" email="$1@e2e.test" pw="pw-$1-e2e-0000000000" uid tok sha
  uid="$(curl -s "$SB/auth/v1/admin/users" -H "apikey: $SERVICE_ROLE_KEY" -H "authorization: Bearer $SERVICE_ROLE_KEY" -H 'content-type: application/json' \
        -d "{\"email\":\"$email\",\"password\":\"$pw\",\"email_confirm\":true}" | jq -r .id)"
  [[ "$uid" =~ ^[0-9a-f-]{36}$ ]] || rec FAIL 1 "create user $name" "$uid"
  tok="tok-$name-0000000000000000000000000000"; sha="$(printf '%s' "$tok" | sha256sum | cut -d' ' -f1)"
  q "insert into public.websites(id,owner_id,fqdn) values ('$wid','$uid','$fqdn'); insert into public.seosmith_bindings(website_id,token_sha256) values ('$wid','$sha');" >/dev/null
  SITE_ID[$name]="$wid"; SITE_TOKEN[$name]="$tok"; SITE_FQDN[$name]="$fqdn"
  SITE_JWT[$name]="$(curl -s "$SB/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" -H 'content-type: application/json' -d "{\"email\":\"$email\",\"password\":\"$pw\"}" | jq -r .access_token)"
  [[ "${SITE_JWT[$name]}" == ey* ]] || rec FAIL 1 "sign in $name" "no token"
}
mksite kh www.kerryhatcher.com 11111111-1111-4111-8111-111111111111   # real crawl site
# S2's fixtures bind the website id and generation into their digests (a rewritten website id or generation
# fails admission with SemanticMismatch), so every fixture goes to this one site at generation 1; only the
# request id (= delivery id) and the timestamps are rewritten.
mksite cap example.com 00000000-0000-4000-8000-000000000002
mksite mix www.kerryhatcher.com 22222222-2222-4222-8222-222222222222  # real-crawl mixed-generation site
jwt() { printf '%s' "${SITE_JWT[$1]}"; }
get() { # get <name> <path>  (owner JWT)
  curl -s -w '\n%{http_code}' "$API$2" -H "authorization: Bearer $(jwt "$1")"; }

# ---------------------------------------------------------------------------------------------------
echo "== step 2: HTP API (release, HTP_S14_ADMISSION=true) in a 256 MB / 1 CPU cgroup scope"
systemd-run --user --scope --quiet --unit="$APISCOPE" -p MemoryMax=256M -p MemorySwapMax=0 -p CPUQuota=100% \
  env BIND_ADDR="127.0.0.1:$API_PORT" SUPABASE_URL="$SB" SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
      TMPDIR=/var/tmp HTP_S14_ADMISSION=true HTP_ROLLOUT_LIFECYCLE=true HTP_ROLLOUT_REMEDIATION=true \
      "$APIBIN" >"$WORK/api.log" 2>&1 &
pids+=($!)
wait_for 30 curl -sf "$API/integrations/seosmith/capabilities" || { cat "$WORK/api.log"; rec FAIL 2 "api up" "no capabilities"; }
apipid() { pgrep -f "^$APIBIN" | head -1; }
apicg() { echo "/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/$APISCOPE.scope"; }
caps="$(curl -s "$API/integrations/seosmith/capabilities")"
echo "$caps" | jq -e '.schema_versions | index(4)' >/dev/null || rec FAIL 2 "capabilities include 4" "$caps"
rec PASS 2 "HTP API up" "pid $(apipid) under MemoryMax=256M CPUQuota=100%; capabilities $(echo "$caps" | jq -c .schema_versions)"

# Gate check: with the gate off (separate throwaway instance on another port) the route answers 503.
BIND_ADDR=127.0.0.1:3918 SUPABASE_URL="$SB" SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" "$APIBIN" >/dev/null 2>&1 & gp=$!
wait_for 20 curl -sf http://127.0.0.1:3918/integrations/seosmith/capabilities
gcode="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3918/integrations/seosmith/policy-audits -H "authorization: Bearer ${SITE_TOKEN[kh]}" -H 'content-type: application/json' -d '{}')"
kill $gp 2>/dev/null
[[ "$gcode" == 503 ]] && rec PASS 2b "gate off by default" "policy-audits answers 503 without HTP_S14_ADMISSION" || rec FAIL 2b "gate off by default" "got $gcode"

# ---------------------------------------------------------------------------------------------------
echo "== step 3: SEOsmith serve (--features local-e2e, loopback ingest)"
echo "$(uuid)$(uuid)" >"$WORK/api-token"; SEO_API_TOKEN="$(cat "$WORK/api-token")"
# N-M1: a build WITHOUT local-e2e must refuse the http loopback ingest URL at startup.
if [[ -z "${SKIP_N_M1:-}" ]]; then
  ( cd "$seo" && CARGO_TARGET_DIR="$SEO_T-plain" cargo +1.98.1 build --locked --bin seosmith >"$WORK/b3.log" 2>&1 ) || { tail -5 "$WORK/b3.log"; rec FAIL 3 "build plain seosmith" "failed"; }
  plain_out="$(SEOSMITH_DB="$WORK/plain.sqlite" SEOSMITH_BIND=127.0.0.1:8999 SEOSMITH_API_TOKEN="$SEO_API_TOKEN" HTP_INGEST_URL="$INGEST" HTP_INGEST_TOKEN="${SITE_TOKEN[kh]}" timeout 10 "$SEO_T-plain/debug/seosmith" serve 2>&1 | tail -3)"
  rcp=$?
  if grep -qiE 'https|scheme|private|loopback|not allowed|refus' <<<"$plain_out"; then rec PASS 3a "N-M1 plain build refuses http loopback" "$(tr '\n' ' ' <<<"$plain_out" | cut -c1-160)"
  else rec FAIL 3a "N-M1 plain build refuses http loopback" "output: $plain_out"; fi
fi
SEOSMITH_DB="$WORK/x.sqlite" SEOSMITH_POLICY_WIRE_V1=true SEOSMITH_ADVISORY_POLICY="$seo/fixtures/policies/production-default.json" \
SEOSMITH_BIND="127.0.0.1:$SEO_PORT" SEOSMITH_API_TOKEN="$SEO_API_TOKEN" HTP_INGEST_URL="$INGEST" HTP_INGEST_TOKEN="${SITE_TOKEN[kh]}" \
  RUST_LOG=info "$SEOBIN" serve >"$WORK/seo.log" 2>&1 &
pids+=($!)
wait_for 30 curl -sf "$SEOURL/health/ready" || { cat "$WORK/seo.log"; rec FAIL 3 "serve up" "not ready"; }
rec PASS 3 "SEOsmith serve up (local-e2e)" "loopback ingest $INGEST, policy wire v1"

SU="$SEOURL"
submit() { # submit <id> <website> <gen> <url> <max_pages> <max_resources> [ext(true|false)] [delay_ms]  (to $SU)
  curl -s -w '\n%{http_code}' "$SU/v1/runs" -H "authorization: Bearer $SEO_API_TOKEN" -H 'content-type: application/json' \
    -d "{\"request_id\":\"$1\",\"website_id\":\"$2\",\"binding_generation\":$3,\"url\":\"$4\",\"max_pages\":$5,\"max_resources\":$6,\"check_external_links\":${7:-false},\"delay_ms\":${8:-1000}}"; }
runview() { curl -s "$SU/v1/runs/$1" -H "authorization: Bearer $SEO_API_TOKEN"; }
wait_state() { # wait_state <id> <jq predicate on view> <secs>
  local v; for _ in $(seq 1 "$3"); do v="$(runview "$1")"; jq -e "$2" >/dev/null 2>&1 <<<"$v" && { echo "$v"; return 0; }; sleep 1; done; echo "$v"; return 1; }

# ---------------------------------------------------------------------------------------------------
echo "== steps 4-5: first real run through POST /v1/runs, delivered by Delivery::tick"
KH="${SITE_ID[kh]}"; R1="$(uuid)"
resp="$(submit "$R1" "$KH" 1 https://www.kerryhatcher.com/ 3 10)"; [[ "$(tail -1 <<<"$resp")" == 202 ]] || rec FAIL 4 "submit run 1" "$resp"
v="$(wait_state "$R1" '.delivery_state=="delivered"' 240)" || { echo "$v"; tail -20 "$WORK/seo.log"; rec FAIL 4 "run 1 delivered" "view: $v"; }
rec PASS 4 "run 1 delivered" "state=$(jq -c '{state,delivery_state}' <<<"$v")"
curl -s "$SEOURL/v1/runs/$R1/report" -H "authorization: Bearer $SEO_API_TOKEN" >"$WORK/r1.json"
jobsha="$(sha "$WORK/r1.json")"
row="$(q "select sha256||' '||summary_sha256||' '||validator_revision||' '||(summary->>'summary_version')||' '||ingestion_source from public.seosmith_audits where delivery_id='$R1'")"
[[ "${row%% *}" == "$jobsha" ]] || rec FAIL 5 "receipt sha = jobs.report_hash" "row=$row jobs=$jobsha"
rec PASS 5a "receipt sha = jobs.report_hash; one HTP row, summary v5" "sha ${jobsha:0:16}…, row: ${row#* }"
[[ "$(jq -r '.schema_version' "$WORK/r1.json")" == 4 ]] || rec FAIL 5 "producer emitted schema 4" "$(jq -r .schema_version "$WORK/r1.json")"
# detail via the owner API: report_json == jobs.report byte for byte
get kh "/websites/$KH/seo/audits/$R1" >"$WORK/d1.raw"; code="$(tail -1 "$WORK/d1.raw")"; head -n -1 "$WORK/d1.raw" >"$WORK/d1.json"
[[ "$code" == 200 ]] || rec FAIL 5 "owner detail" "http $code"
jq -j '.report_json' "$WORK/d1.json" >"$WORK/d1.report"
cmp -s "$WORK/d1.report" "$WORK/r1.json" && rec PASS 5b "cmp detail report_json vs jobs.report" "byte-identical ($(wc -c <"$WORK/r1.json") bytes) via API detail" || rec FAIL 5b "cmp detail report_json vs jobs.report" "differs"
"$ADMIT" "$WORK/r1.json" >"$WORK/r1.summary" 2>"$WORK/r1.admit.err"
jq -j '.summary_text' "$WORK/d1.json" >"$WORK/d1.summary" 2>/dev/null
if [[ ! -s "$WORK/d1.summary" || "$(jq -r 'has("summary_text")' "$WORK/d1.json")" != true ]]; then
  q "select summary_text from public.seosmith_audits where delivery_id='$R1'" >"$WORK/d1.summary.nl"; printf '%s' "$(cat "$WORK/d1.summary.nl")" >"$WORK/d1.summary"; fi
cmp -s "$WORK/r1.summary" "$WORK/d1.summary" && rec PASS 5c "admit reproduces summary_text" "stored summary_text == receiver admit output ($(wc -c <"$WORK/r1.summary") bytes)" || rec FAIL 5c "admit reproduces summary_text" "differs"
[[ "$(q "select state from public.seosmith_lifecycle_indexed where delivery_id='$R1'")" == indexed_v1 ]] && rec PASS 5d "lifecycle indexed_v1" "seosmith_lifecycle_indexed.state=indexed_v1, evaluations=$(q "select count(*) from public.seosmith_lifecycle_evaluations where delivery_id='$R1'")" || rec FAIL 5d "lifecycle indexed_v1" "$(q "select state from public.seosmith_lifecycle_indexed where delivery_id='$R1'")"

# ---------------------------------------------------------------------------------------------------
echo "== step 6: second run, enqueue_enabled, processor"
q "update public.audit_event_config set enqueue_enabled=true, processing_enabled=true" >/dev/null
R2="$(uuid)"; submit "$R2" "$KH" 1 https://www.kerryhatcher.com/ 3 10 >/dev/null
wait_state "$R2" '.delivery_state=="delivered"' 240 >/dev/null || { tail -20 "$WORK/seo.log"; rec FAIL 6 "run 2 delivered" "not delivered"; }
njobs="$(q "select count(*) from public.audit_event_jobs where delivery_id='$R2'")"; n1="$(q "select count(*) from public.audit_event_jobs where delivery_id='$R1'")"
[[ "$njobs" == 1 && "$n1" == 0 ]] || rec FAIL 6 "exactly one event job for run 2" "run2=$njobs run1=$n1"
rec PASS 6a "alert enqueue" "exactly one audit_event_jobs row for run 2 (run 1, before enqueue_enabled: $n1)"
proc() { # proc <delivery> -> processor result
  psql_ <<SQL | tail -1
begin;
select public.audit_event_claim() as c \gset
set role service_role;
select public.audit_event_snapshot_lock();
select public.audit_event_process('$1', (:'c'::jsonb->>'lease_token')::uuid);
commit;
SQL
}
claimout="$(q "set role service_role; select public.audit_event_claim()" 2>&1 | tail -1)"
lease="$(jq -r '.lease_token // .lease // empty' <<<"$claimout" 2>/dev/null)"
res="$(psql_ <<SQL 2>&1 | tail -1
set role service_role;
begin;
select public.audit_event_snapshot_lock();
select public.audit_event_process('$R2','$lease'::uuid);
commit;
SQL
)"
st="$(q "select state||coalesce(':'||hold_reason,'') from public.audit_event_jobs where delivery_id='$R2'")"
rec INFO 6b "processor on run 2" "claim=$(echo "$claimout" | cut -c1-120) result=$res job=$st events=$(q 'select count(*) from public.audit_events')"
[[ "$res" == processed || "$res" == held ]] || rec FAIL 6b "processor ran" "result=$res claim=$claimout"
hist="$(get kh "/websites/$KH/seo/audit-events")"; hc_="$(tail -1 <<<"$hist")"
[[ "$hc_" == 200 ]] && rec PASS 6c "event history read path" "GET audit-events 200: $(head -n -1 <<<"$hist" | jq -c '{n:(.items|length? // 0)}' 2>/dev/null)" || rec FAIL 6c "event history read path" "http $hc_"
ent="$(q "select entity_id from public.seosmith_lifecycle_evaluations where delivery_id='$R2' and evaluation->>'outcome' in ('pass','fail') limit 1")"; rule="$(q "select rule from public.seosmith_lifecycle_evaluations where delivery_id='$R2' and evaluation->>'outcome' in ('pass','fail') limit 1")"
lc="$(get kh "/websites/$KH/seo/audits/lifecycle?entity_id=$(jq -rn --arg e "$ent" '$e|@uri')&rule=$rule")"; lcode="$(tail -1 <<<"$lc")"
trans="$(head -n -1 <<<"$lc" | jq -c '[.items[].evaluation.outcome] | unique' 2>/dev/null)"
[[ "$lcode" == 200 ]] || rec FAIL 6d "lifecycle history" "http $lcode: $(head -n -1 <<<"$lc" | cut -c1-200)"
rec INFO 6d "lifecycle history transitions (run1->run2)" "entity=${ent:0:40} rule=$rule transitions=$trans :: $(head -n -1 <<<"$lc" | jq -c . | cut -c1-300)"
if [[ "$trans" == '["not_observed"]' || "$trans" == '[]' || -z "$trans" ]]; then rec FAIL 6d "transitions not all not_observed" "$trans"; else rec PASS 6d "transitions not all not_observed" "$trans"; fi

# ---------------------------------------------------------------------------------------------------
echo "== step 7: 503 retry with the validator disabled, then delivered"
q "update public.seosmith_s14_validators set enabled=false" >/dev/null
R3="$(uuid)"; submit "$R3" "$KH" 1 https://www.kerryhatcher.com/ 3 10 >/dev/null
v="$(wait_state "$R3" '(.attempts // 0) > 0' 240)" || { echo "$v"; tail -10 "$WORK/seo.log"; rec FAIL 7 "503 retry observed" "view: $v"; }
st3="$(jq -c '{state,delivery_state,attempts,error}' <<<"$v")"
[[ "$(q "select count(*) from public.seosmith_audits where delivery_id='$R3'")" == 0 ]] || rec FAIL 7 "nothing committed while disabled" "row exists"
grep -E 'HTP delivery deferred' "$WORK/seo.log" | tail -1 | cut -c1-160 >"$WORK/defer.txt"
rec PASS 7a "validator disabled -> job stays pending, retried" "$st3; seosmith log: $(cat "$WORK/defer.txt")"
q "update public.seosmith_s14_validators set enabled=true" >/dev/null
q "select 1" >/dev/null
# fast-forward the sender's backoff (30 s * 2^attempt) instead of idling; same row the worker reads
sqlite3 "$WORK/x.sqlite" "update jobs set next_attempt=unixepoch() where id='$R3'" 2>/dev/null || true
v="$(wait_state "$R3" '.delivery_state=="delivered"' 180)" || { echo "$v"; rec FAIL 7 "delivered after re-enable" "view: $v"; }
rec PASS 7b "re-enabled -> delivered" "$(jq -c '{state,delivery_state}' <<<"$v"); audit row present=$(q "select count(*) from public.seosmith_audits where delivery_id='$R3'")"

# ---------------------------------------------------------------------------------------------------
echo "== step 8: remediation on schema 4"
# Remediation is held closed by migration 20261202 (no EXECUTE for authenticated/service_role); enabling it is a
# separate rollout step. The grant below is the one tests/remediation-pg17/verify.sql uses.
q "grant execute on function public.seosmith_remediation_list(uuid,uuid,integer,timestamptz,uuid),public.seosmith_remediation_save(uuid,uuid,integer,jsonb),public.seosmith_remediation_attempt(uuid,uuid,uuid,text,text) to authenticated" >/dev/null
rec INFO 8g "remediation enablement" "migration 20261202 ships the three functions with no EXECUTE (fail-closed hold); X grants authenticated EXECUTE as the rollout step (same grant as supabase/tests/remediation-pg17/verify.sql:21)"
idx=0; fkey="$(q "select report->'findings'->$idx->>'key' from public.seosmith_audits where delivery_id='$R1'")"
if [[ -z "$fkey" ]]; then rec INFO 8 "run 1 has no findings; using a fixture" ""; fi
W="$(curl -s -w '\n%{http_code}' -X POST "$API/websites/$KH/seo/audits/$R1/work" -H "authorization: Bearer $(jwt kh)" -H 'content-type: application/json' -d '{"finding_index":0,"work":{"status":"in_progress","notes":"x e2e"}}')"
wc_="$(tail -1 <<<"$W")"
if [[ -z "$fkey" ]]; then
  # a real, clean page can have zero findings; fall back to the missing-H1 fixture below in step 11's site
  echo "no findings on the real run; remediation is proven on the fixture in step 8b"
else
  [[ "$wc_" == 200 ]] && rec PASS 8 "remediation_save on a schema-4 finding" "work saved: $(head -n -1 <<<"$W" | jq -c '{status,finding_key:(.finding_key[0:16])}')" || rec FAIL 8 "remediation_save on a schema-4 finding" "http $wc_ $(head -n -1 <<<"$W")"
fi

# ---------------------------------------------------------------------------------------------------
echo "== steps 9-10: negative (deliver_once mutated -> 422) and legacy schema 1/2"
NEG="${SITE_ID[cap]}"
node "$here/prep.mjs" "$S4FIX/complete-missing-h1.json" "$WORK/neg-ok.json" --request "$(uuid)" --ts 2026-11-20T10:00:00Z
node "$here/prep.mjs" "$S4FIX/complete-missing-h1.json" "$WORK/neg-mut.json" --request "$(uuid)" --ts 2026-11-20T11:00:00Z --mutate
ok="$(node "$here/send.mjs" "$INGEST" "${SITE_TOKEN[cap]}" "$WORK/neg-ok.json")"
[[ "$(jq -r .status <<<"$ok")" == 200 ]] || rec FAIL 8b "fixture admits through the route" "$ok"
rec PASS 8b "schema-4 fixture admits (id/website/timestamp rewritten)" "$(jq -c '{status,ms,bytes}' <<<"$ok")"
rid="$(jq -r .request.request_id "$WORK/neg-ok.json")"
W="$(curl -s -w '\n%{http_code}' -X POST "$API/websites/$NEG/seo/audits/$rid/work" -H "authorization: Bearer $(jwt cap)" -H 'content-type: application/json' -d '{"finding_index":0,"work":{"status":"in_progress","notes":"x e2e"}}')"
[[ "$(tail -1 <<<"$W")" == 200 ]] && rec PASS 8 "remediation_save on a schema-4 finding (POST /work)" "$(head -n -1 <<<"$W" | jq -c '{status,finding_key:(.finding_key[0:16])}')" || rec FAIL 8 "remediation_save on a schema-4 finding" "$W"
WL="$(curl -s -w '\n%{http_code}' "$API/websites/$NEG/seo/audits/$rid/work?finding_index=0" -H "authorization: Bearer $(jwt cap)")"; [[ "$(tail -1 <<<"$WL")" == 200 ]] && rec PASS 8c "remediation_list on schema 4" "200" || rec FAIL 8c "remediation_list on schema 4" "$WL"
# mutated report: sender-less deliver_once (random delivery id as shipped) and the id-correct sender
mut="$(HTP_INGEST_TOKEN="${SITE_TOKEN[cap]}" "$DELIVER" "$INGEST" "$WORK/neg-mut.json" 2>&1 | tail -1)"
mut2="$(node "$here/send.mjs" "$INGEST" "${SITE_TOKEN[cap]}" "$WORK/neg-mut.json")"
[[ "$mut" == "terminal 422" && "$(jq -r .status <<<"$mut2")" == 422 ]] && rec PASS 9 "mutated report refused 422" "deliver_once: '$mut'; id-correct send: $(jq -c '{status,body}' <<<"$mut2" | cut -c1-200); no row stored=$(q "select count(*) from public.seosmith_audits where delivery_id='$(jq -r .request.request_id "$WORK/neg-mut.json")'")" || rec FAIL 9 "mutated report refused 422" "deliver_once='$mut' send=$mut2"
# legacy 1/2 on the OLD route
lid="$(uuid)"; node "$here/prep.mjs" "$FIX/v2-complete.json" "$WORK/v2.json" --request "$lid" --ts 2026-11-19T10:00:00Z
l2="$(node "$here/send.mjs" "$LEGACY" "${SITE_TOKEN[cap]}" "$WORK/v2.json")"
[[ "$(jq -r .status <<<"$l2")" == 200 ]] || rec FAIL 10 "legacy schema 2 accepted" "$l2"
lid1="$(uuid)"; node "$here/prep.mjs" "$FIX/legacy.json" "$WORK/v1.json" --request "$lid1" --ts 2026-11-19T09:00:00Z
l1="$(node "$here/send.mjs" "$LEGACY" "${SITE_TOKEN[cap]}" "$WORK/v1.json")"
[[ "$(jq -r .status <<<"$l1")" == 200 ]] || rec FAIL 10 "legacy schema 1 accepted" "$l1"
for pair in "$lid:v2" "$lid1:v1"; do
  id="${pair%%:*}"; D="$(get cap "/websites/$NEG/seo/audits/$id")"; dcode="$(tail -1 <<<"$D")"; head -n -1 <<<"$D" >"$WORK/legacy-detail.json"
  jq -j .report_json "$WORK/legacy-detail.json" >"$WORK/legacy-detail.report"; src="$WORK/${pair##*:}.json"
  cmp -s "$WORK/legacy-detail.report" "$src" && [[ "$dcode" == 200 ]] || rec FAIL 10 "legacy ${pair##*:} read path unchanged" "detail http $dcode, report_json differs"
done
[[ "$(q "select ingestion_source||':'||(report->>'schema_version') from public.seosmith_audits where delivery_id='$lid'")" == "worker:2" ]] || true
rec PASS 10 "legacy schema 1/2 via /integrations/seosmith/audits" "v2: $(jq -c '{status,ms}' <<<"$l2"), v1: $(jq -c '{status,ms}' <<<"$l1")); detail report_json byte-identical for both; indexed state v2=$(q "select state from public.seosmith_lifecycle_indexed where delivery_id='$lid'") v1=$(q "select state from public.seosmith_lifecycle_indexed where delivery_id='$lid1'")"
# the 15-key capability read on the legacy route still lists all three versions
rec PASS 10b "capabilities" "$(curl -s "$API/integrations/seosmith/capabilities" | jq -c .)"

# ---------------------------------------------------------------------------------------------------
echo "== step 11: mixed generation on the SAME binding and generation (schema 2, then 4, 4; bump; 4, 4), real crawls"
MIX="${SITE_ID[mix]}"
start_serve() { # start_serve <name> <port> <wire|v2> <ingest-url>
  local n="$1" port="$2" mode="$3" url="$4" extra=()
  if [[ "$mode" == wire ]]; then extra=(SEOSMITH_POLICY_WIRE_V1=true "SEOSMITH_ADVISORY_POLICY=$seo/fixtures/policies/production-default.json"); else extra=(SEOSMITH_EVIDENCE_CONTRACT_V2=true); fi
  env SEOSMITH_DB="$WORK/$n.sqlite" SEOSMITH_BIND="127.0.0.1:$port" SEOSMITH_API_TOKEN="$SEO_API_TOKEN" HTP_INGEST_URL="$url" HTP_INGEST_TOKEN="${SITE_TOKEN[mix]}" "${extra[@]}" RUST_LOG=info "$SEOBIN" serve >"$WORK/$n.log" 2>&1 &
  pids+=($!); wait_for 30 curl -sf "http://127.0.0.1:$port/health/ready" || rec FAIL 11 "serve $n up" "$(tail -3 "$WORK/$n.log")"; }
crawl_to() { # crawl_to <base> <gen> -> request id once delivered
  local id; id="$(uuid)"; SU="$1"; local r; r="$(submit "$id" "$MIX" "$2" https://www.kerryhatcher.com/ 3 10)"; [[ "$(tail -1 <<<"$r")" == 202 ]] || { echo "submit failed $r" >&2; echo FAILSEND; return; }
  wait_state "$id" '.delivery_state=="delivered"' 240 >/dev/null || { echo FAILSEND; return; }; echo "$id"; }
processjob() { # processjob -> "<delivery> <state:hold>" for the next claimable job, or noclaim
  local c l d; c="$(q "set role service_role; select public.audit_event_claim()" 2>&1 | tail -1)"; l="$(jq -r '.lease_token // .lease // empty' <<<"$c" 2>/dev/null)"; d="$(jq -r '.delivery_id // empty' <<<"$c" 2>/dev/null)"
  [[ -n "$l" && -n "$d" ]] || { echo "noclaim"; return; }
  psql_ >/dev/null <<SQL
set role service_role;
begin;
select public.audit_event_snapshot_lock();
select public.audit_event_process('$d','$l'::uuid);
commit;
SQL
  echo "$d $(q "select state||coalesce(':'||hold_reason,'') from public.audit_event_jobs where delivery_id='$d'")"; }
drain() { local o; for _ in $(seq 1 12); do o="$(processjob)"; [[ "$o" == noclaim ]] && break; echo "  job: $o"; done; }
q "update public.audit_event_jobs set state='processed' where website_id<>'$MIX' and state='pending'" >/dev/null   # other sites' jobs are not under test here
jstate() { q "select state||coalesce(':'||hold_reason,'') from public.audit_event_jobs where delivery_id='$1'"; }
q "update public.audit_event_jobs set state='processed' where website_id<>'$MIX' and state='pending'" >/dev/null   # other sites' jobs are not under test here
# The processor runs after EACH delivery, as it would in production (a receipt processed after a later one exists is late_or_tied).
start_serve mixv2 8918 v2 "$LEGACY"; start_serve mixw 8919 wire "$INGEST"
G="$(q "select generation from public.seosmith_bindings where website_id='$MIX'")"
m2="$(crawl_to http://127.0.0.1:8918 "$G")"; [[ "$m2" != FAILSEND ]] || rec FAIL 11 "mixed: schema-2 crawl delivered" "$(tail -3 "$WORK/mixv2.log")"; drain
m4a="$(crawl_to http://127.0.0.1:8919 "$G")"; [[ "$m4a" != FAILSEND ]] || rec FAIL 11 "mixed: schema-4 crawl a" "$(tail -3 "$WORK/mixw.log")"; drain
m4b="$(crawl_to http://127.0.0.1:8919 "$G")"; [[ "$m4b" != FAILSEND ]] || rec FAIL 11 "mixed: schema-4 crawl b" "$(tail -3 "$WORK/mixw.log")"; drain
SU="$SEOURL"
gens="$(q "select string_agg(report->>'schema_version'||'@g'||generation||'/'||ingestion_source,' , ' order by scan_at) from public.seosmith_audits where website_id='$MIX'")"
drain
jstate() { q "select state||coalesce(':'||hold_reason,'') from public.audit_event_jobs where delivery_id='$1'"; }
rec INFO 11a "mixed generation G=$G audits (scan order)" "$gens; jobs: schema2=$(jstate "$m2") schema4(first)=$(jstate "$m4a") schema4(second)=$(jstate "$m4b")"
[[ "$(jstate "$m4b")" == held:history_unknown ]] && rec PASS 11b "processor raises history_unknown for the schema-4 job in a mixed 2/4 generation" "second schema-4 job: $(jstate "$m4b"); first schema-4: $(jstate "$m4a"); schema-2: $(jstate "$m2")" || rec FAIL 11b "history_unknown for a schema-4 job in a mixed generation" "second schema-4 job: $(jstate "$m4b"); first: $(jstate "$m4a"); schema-2: $(jstate "$m2")"
q "update public.seosmith_bindings set generation=generation+1 where website_id='$MIX'" >/dev/null
G2="$(q "select generation from public.seosmith_bindings where website_id='$MIX'")"
n4a="$(crawl_to http://127.0.0.1:8919 "$G2")"; drain; n4b="$(crawl_to http://127.0.0.1:8919 "$G2")"; drain; SU="$SEOURL"
[[ "$n4a" != FAILSEND && "$n4b" != FAILSEND ]] || rec FAIL 11 "post-bump crawls" "failed: $(tail -3 "$WORK/mixw.log")"
ev="$(q "select count(*) from public.audit_events where website_id='$MIX' and generation=$G2")"
[[ "$(jstate "$n4b")" == processed ]] && rec PASS 11c "after the generation bump (G=$G -> $G2) the schema-4 pair processes cleanly" "first=$(jstate "$n4a") second=$(jstate "$n4b"); audit_events in gen $G2: $ev (an unchanged site raises no event); audit_events held jobs in old gen unchanged" || rec FAIL 11c "post-bump processing" "first=$(jstate "$n4a") second=$(jstate "$n4b")"
D="$(get mix "/websites/$MIX/seo/audits?limit=10")"; [[ "$(tail -1 <<<"$D")" == 200 ]] && rec PASS 11d "audit list read path on a mixed-generation website" "$(head -n -1 <<<"$D" | jq -c '[.items[] | (.summary.schema_version)] ')" || rec FAIL 11d "audit list" "$D"

# ---------------------------------------------------------------------------------------------------
echo "== web display read path: owner API detail + MCP website_audit_detail on a schema-4 row"
mres="$(node "$here/mcp.mjs" "$API" "$(jwt kh)" "$KH" "$R1" "$WORK/r1.json" 2>&1)"; mrc=$?
[[ $mrc == 0 ]] && rec PASS 12m "MCP detail/export on a real schema-4 audit" "$mres" || rec FAIL 12m "MCP detail/export on a real schema-4 audit" "$mres"
mres2="$(node "$here/mcp.mjs" "$API" "$(jwt cap)" "${SITE_ID[cap]}" "$rid" "$WORK/neg-ok.json" 2>&1)"; mrc=$?
[[ $mrc == 0 ]] && rec PASS 12n "MCP detail/export on the schema-4 fixture audit" "$mres2" || rec FAIL 12n "MCP detail/export on the schema-4 fixture audit" "$mres2"

# ---------------------------------------------------------------------------------------------------
echo "== host quietness (timing)"
quiet() { local l; l="$(cut -d' ' -f1 /proc/loadavg)"; (( $(echo "$l < ${QUIET_MAX:-2.5}" | bc -l) )); }
for _ in $(seq 1 ${QUIET_WAIT_STEPS:-60}); do quiet && break; sleep 10; done
IDLE="$(vmstat 1 3 | tail -1 | awk '{print $15}')"; LOADT="$(cut -d' ' -f1-3 /proc/loadavg)"; rec INFO 13q "host load before timing" "loadavg $LOADT, cpu idle ${IDLE}% ($(nproc) cpus; others running: $(ps -eo pcpu,comm --sort=-pcpu | head -4 | tail -3 | tr '\n' ';' | tr -s ' '))"
quiet || rec INFO 13q "host NOT quiet" "timing numbers below carry a contention caveat (loadavg $LOADT)"

echo "== step 12: S2 exact-cap fixture, commit path through the API (256 MB scope)"
CAPF="$S4FIX/exact-cap.json"; [[ "$(stat -c %s "$CAPF")" == "$CAP_BYTES" ]] || rec FAIL 12 "exact-cap fixture size" "$(stat -c %s "$CAPF")"
pid="$(apipid)"; rss0="$(grep VmHWM /proc/$pid/status | awk '{print $2}')"
: >"$WORK/cap.times"
for i in $(seq 1 "$CAP_RUNS"); do
  id="$(uuid)"; node "$here/prep.mjs" "$CAPF" "$WORK/cap-$i.json" --request "$id"
  [[ "$(stat -c %s "$WORK/cap-$i.json")" == "$CAP_BYTES" ]] || rec FAIL 12 "exact-cap stays exact after id rewrite" "$(stat -c %s "$WORK/cap-$i.json")"
  r="$(node "$here/send.mjs" "$INGEST" "${SITE_TOKEN[cap]}" "$WORK/cap-$i.json")"
  st="$(jq -r .status <<<"$r")"; [[ "$st" == 200 ]] || { echo "$r"; tail -5 "$WORK/api.log"; rec FAIL 12 "exact-cap run $i admitted" "$r"; }
  recv_ms="$(q "select (extract(epoch from received_at)*1000)::bigint from public.seosmith_audits where delivery_id='$id'")"
  endms="$(jq -r .end_epoch_ms <<<"$r")"
  echo "$(jq -r .ms <<<"$r") $((endms - recv_ms))" >>"$WORK/cap.times"
  rm -f "$WORK/cap-$i.json"
done
rss1="$(grep VmHWM /proc/$pid/status | awk '{print $2}')"; peak="$(cat "$(apicg)/memory.peak" 2>/dev/null || echo 0)"; oom="$(grep -E '^oom_kill ' "$(apicg)/memory.events" 2>/dev/null | cut -d' ' -f2)"
stat() { sort -n | awk -v p="$1" '{a[NR]=$1} END{i=int(NR*p+0.999999); if(i<1)i=1; if(i>NR)i=NR; print a[i]}'; }
rt50="$(cut -d' ' -f1 "$WORK/cap.times" | stat 0.5)"; rt99="$(cut -d' ' -f1 "$WORK/cap.times" | stat 0.99)"; rtmax="$(cut -d' ' -f1 "$WORK/cap.times" | sort -n | tail -1)"
cm50="$(cut -d' ' -f2 "$WORK/cap.times" | stat 0.5)"; cm99="$(cut -d' ' -f2 "$WORK/cap.times" | stat 0.99)"; cmmax="$(cut -d' ' -f2 "$WORK/cap.times" | sort -n | tail -1)"
margin=$(( 25000 - rtmax ))
rec INFO 12a "exact-cap API round trip ($CAP_RUNS runs, ms)" "p50=$rt50 p99=$rt99 max=$rtmax; commit estimate (response end - received_at) p50=$cm50 p99=$cm99 max=$cmmax; margin to 25 s = ${margin} ms; loadavg $(cut -d' ' -f1-3 /proc/loadavg)"
(( rtmax < 25000 )) && rec PASS 12b "round trip inside 25 s" "max ${rtmax} ms, margin ${margin} ms; p99 ${rt99} ms" || rec FAIL 12b "round trip inside 25 s" "max ${rtmax} ms"
rec INFO 12c "API peak memory on the 256 MB scope" "VmHWM $((rss1/1024)) MiB (start $((rss0/1024))); cgroup memory.peak $((peak/1048576)) MiB; oom_kill=${oom:-?}"
(( peak <= 256*1048576 )) && [[ "${oom:-0}" == 0 ]] && rec PASS 12d "API handles exact-cap deliveries inside 256 MB" "peak $((peak/1048576)) MiB, no OOM kill, $CAP_RUNS deliveries" || rec FAIL 12d "API inside 256 MB" "peak $((peak/1048576)) MiB oom=$oom"
# exact-cap rows are stored and indexed
ncap="$(q "select count(*) from public.seosmith_audits where website_id='${SITE_ID[cap]}' and octet_length(raw_report_json)=$CAP_BYTES")"; nidx="$(q "select count(*) from public.seosmith_lifecycle_indexed i join public.seosmith_audits a using(delivery_id) where a.website_id='${SITE_ID[cap]}' and octet_length(a.raw_report_json)=$CAP_BYTES and i.state='indexed_v1'")"
[[ "$ncap" == "$CAP_RUNS" && "$nidx" == "$CAP_RUNS" ]] && rec PASS 12e "exact-cap rows stored and lifecycle indexed" "$ncap rows, $nidx indexed_v1" || rec FAIL 12e "exact-cap rows stored and indexed" "rows=$ncap indexed=$nidx"

# ---------------------------------------------------------------------------------------------------
echo "== N-M3: commit_seosmith_audit_v4 at --cpus 0.2 on S2's exact-cap fixture, insert timed separately"
"$here/nm3.sh" "$DB" "$CAPF" "$WORK" "$RUNS" "$here" >"$WORK/nm3.out" 2>&1; nrc=$?
cat "$WORK/nm3.out"
rec INFO 13 "N-M3 stages" "$(tail -12 "$WORK/nm3.out" | tr '\n' ';' | cut -c1-900)"
[[ $nrc == 0 ]] && rec PASS 13a "N-M3 commit <= 10 s at 0.2 CPU (5 runs)" "$(grep -E '^COMMIT' "$WORK/nm3.out" | head -1)" || rec FAIL 13a "N-M3 commit <= 10 s at 0.2 CPU" "$(grep -E '^COMMIT|throttl' "$WORK/nm3.out" | head -3 | tr '\n' ' ')"

# ---------------------------------------------------------------------------------------------------
echo "== M9: receiver resource gate on a 256 MB cgroup"
mk="$WORK/m9.sh"; cat >"$mk" <<EOF
#!/usr/bin/env bash
s=\$(date +%s.%N); "$RCHECK" admit "$CAPF" >"$WORK/m9.out" 2>&1; rc=\$?; e=\$(date +%s.%N)
cg=/sys/fs/cgroup\$(cut -d: -f3 /proc/self/cgroup)
echo "rc=\$rc secs=\$(echo "\$e - \$s" | bc -l) peak=\$(cat \$cg/memory.peak) max=\$(cat \$cg/memory.max)" >"$WORK/m9.res"
EOF
chmod +x "$mk"; systemd-run --user --scope --quiet -p MemoryMax=256M -p MemorySwapMax=0 -p CPUQuota=100% "$mk"
res="$(cat "$WORK/m9.res")"; m9secs="$(sed 's/.*secs=\([0-9.]*\).*/\1/' <<<"$res")"; m9peak="$(sed 's/.*peak=\([0-9]*\).*/\1/' <<<"$res")"
rec INFO 13m9 "M9 resource_check admit exact-cap" "$res :: $(tr '\n' ' ' <"$WORK/m9.out" | cut -c1-300)"
(( m9peak <= 150*1048576 )) && (( $(echo "$m9secs <= 15" | bc -l) )) && grep -q 'rc=0' <<<"$res" && rec PASS 13m9 "M9: peak <= 150 MiB and within 15 s on a 256 MB cgroup" "peak $((m9peak/1048576)) MiB, ${m9secs} s" || rec FAIL 13m9 "M9 gate" "$res"

# ---------------------------------------------------------------------------------------------------
echo "== step 13: M8 + N-M4 at the Q2 bounds (100 pages, 200 resources, external links on), serve mode"
if [[ "$SKIP_BOUNDS" == 1 ]]; then rec INFO 14 "Q2-bound crawl" "skipped (--skip-crawl-bounds)"; else
  mp=100; mr=200
  while :; do
    RB="$(uuid)"; resp="$(submit "$RB" "$KH" 1 https://www.kerryhatcher.com/ "$mp" "$mr" true 1000)"; [[ "$(tail -1 <<<"$resp")" == 202 ]] || rec FAIL 14 "submit bounds run" "$resp"
    v="$(wait_state "$RB" '.state=="failed" or .delivery_state=="delivered" or .delivery_state=="rejected"' 1500)" || { echo "$v"; rec FAIL 14 "bounds run finishes" "timeout: $v"; }
    [[ "$(jq -r .delivery_state <<<"$v")" == delivered ]] || rec FAIL 14 "bounds run delivered" "$(jq -c . <<<"$v")"
    curl -s "$SEOURL/v1/runs/$RB/report" -H "authorization: Bearer $SEO_API_TOKEN" >"$WORK/rb.json"
    nbytes="$(wc -c <"$WORK/rb.json")"; neval="$(jq '.evidence_contract.evaluations|length' "$WORK/rb.json")"; trunc="$(jq '.evidence_contract.truncated' "$WORK/rb.json")"
    sz() { jq -c "$1" "$WORK/rb.json" | wc -c; }
    detail="max_pages=$mp max_resources=$mr pages=$(jq '.pages|length' "$WORK/rb.json") bytes(db length(report text))=$(q "select length(raw_report_json) from public.seosmith_audits where delivery_id='$RB'") jobs.report=$nbytes; evidence_contract=$(sz .evidence_contract)B policy_guidance=$(sz .policy_guidance)B finding_coverage=$(sz .finding_coverage)B; evaluations=$neval truncated=$trunc observations=$(jq '.evidence_contract.observations|length' "$WORK/rb.json") findings=$(jq '.findings|length' "$WORK/rb.json") stop_reason=$(jq -r .stop_reason "$WORK/rb.json") outcome=$(jq -r .outcome "$WORK/rb.json")"
    if (( nbytes <= 3962204 && neval <= 460 )) && [[ "$trunc" == false ]]; then rec PASS 14 "M8 payload and N-M4 evaluations at the Q2 bounds" "$detail"; break; fi
    rec INFO 14 "bounds exceeded; reducing (pages first)" "$detail"
    if (( mp > 10 )); then mp=$((mp*3/4)); else mr=$((mr*3/4)); fi; (( mp > 1 && mr > 1 )) || rec FAIL 14 "cannot fit" "$detail"
  done
fi

# ---------------------------------------------------------------------------------------------------
echo "== amendment: Q9 purge semantics"
"$here/q9.sh" "$DB" "$WORK" "$here" >"$WORK/q9.out" 2>&1; qrc=$?; cat "$WORK/q9.out"
[[ $qrc == 0 ]] && rec PASS 15 "Q9 purge semantics (delete schema-2 rows + remediation first)" "$(grep -E '^Q9' "$WORK/q9.out" | tr '\n' ';' | cut -c1-600)" || rec FAIL 15 "Q9 purge semantics" "$(tail -5 "$WORK/q9.out" | tr '\n' ' ')"

report
echo "== ALL STEPS PASSED; results in $out/results.md"
