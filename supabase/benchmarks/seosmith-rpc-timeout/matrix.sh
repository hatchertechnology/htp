#!/usr/bin/env bash
set -euo pipefail
B="http://127.0.0.1:$RESTPORT"; J=$(cat "$WORK/jwt")
call(){ local expected=$1 endpoint=$2 data=$3 auth=$4 code; local -a headers=(); [[ -n "$auth" ]] && headers=(-H "Authorization: Bearer $J"); code=$(curl -sS --max-time 20 -o "$WORK/response" -w '%{http_code} %{time_total}' -X POST "$B/rpc/$endpoint" -H 'Content-Type: application/json' "${headers[@]}" --data-binary "$data"); echo "$endpoint $code"; [[ "${code%% *}" = "$expected" ]]; }
call 500 timeout_unrelated_probe '{}' ''
call 200 timeout_unrelated_probe '{}' yes
call 500 timeout_auth_limit '{}' yes
call 200 timeout_hoist_success '{}' ''
call 500 timeout_hoisted_probe '{}' ''
podman exec -e PGPASSWORD=dryrun "$PG" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -h 127.0.0.1 -d postgres -Atc 'select count(*)=0 from public.timeout_probe_rows' | grep -qx t
if podman exec -e PGPASSWORD=dryrun -e 'PGOPTIONS=-c statement_timeout=3s' "$PG" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -h 127.0.0.1 -d postgres -c 'set role anon' -c 'select public.timeout_hoist_success()'; then echo 'direct SQL unexpectedly survived 3s' >&2; exit 1; fi
for kind in token string; do for n in 0 1 2; do for mode in worker import; do
 name="$kind-$mode-$n"; ep=ingest_seosmith_audit; auth=''; if [[ "$mode" = import ]]; then ep=import_seosmith_audit; auth=yes; fi
 echo "# $name"; call 200 "$ep" "@$WORK/$name.json" "$auth"
 node -e "const f=require('fs'),m=JSON.parse(f.readFileSync(process.argv[1])),r=JSON.parse(f.readFileSync(process.argv[2]));if(!r.accepted||r.delivery_id!==m.id||r.sha256!==m.sha)process.exit(1)" "$WORK/$name.meta" "$WORK/response"
done; done; done
call 200 ingest_seosmith_audit "@$WORK/token-worker-0.json" ''
node - "$WORK" <<'JS'
const fs=require('fs'),c=require('crypto'),d=process.argv[2];let r=JSON.parse(fs.readFileSync(d+'/token-worker-0.json'));r.p_report_json+=' ';r.p_sha256=c.createHash('sha256').update(r.p_report_json).digest('hex');fs.writeFileSync(d+'/conflict.json',JSON.stringify(r));let q=JSON.parse(fs.readFileSync(d+'/token-worker-1.json'));q.p_token='y'.repeat(64);q.p_delivery_id='00000000-0000-4000-8000-000000000089';q.p_report_json=q.p_report_json.replace(/20000000-0000-4000-8000-\d{12}/,q.p_delivery_id).replace(/}$/,',\"duplicate\":{\"a\":1,\"a\":2}}');q.p_sha256=c.createHash('sha256').update(q.p_report_json).digest('hex');fs.writeFileSync(d+'/invalid-token.json',JSON.stringify(q));q=JSON.parse(fs.readFileSync(d+'/token-worker-2.json'));q.p_delivery_id='00000000-0000-4000-8000-000000000088';q.p_report_json=q.p_report_json.replace(/20000000-0000-4000-8000-\d{12}/,q.p_delivery_id).replace(/}$/,',"duplicate":{"a":1,"a":2}}');q.p_sha256=c.createHash('sha256').update(q.p_report_json).digest('hex');fs.writeFileSync(d+'/duplicate.json',JSON.stringify(q));
JS
call 409 ingest_seosmith_audit "@$WORK/conflict.json" ''
node -e "if(JSON.parse(require('fs').readFileSync(process.argv[1])).message!=='delivery_conflict')process.exit(1)" "$WORK/response"
call 401 ingest_seosmith_audit "@$WORK/invalid-token.json" ''
node -e "if(JSON.parse(require('fs').readFileSync(process.argv[1])).message!=='invalid_worker')process.exit(1)" "$WORK/response"
call 400 ingest_seosmith_audit "@$WORK/duplicate.json" ''
node -e "if(JSON.parse(require('fs').readFileSync(process.argv[1])).message!=='invalid_or_duplicate_json_keys')process.exit(1)" "$WORK/response"
podman exec -e PGPASSWORD=dryrun "$PG" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -h 127.0.0.1 -d postgres -Atc "select count(*)=0 from public.seosmith_audits where delivery_id='00000000-0000-4000-8000-000000000088'" | grep -qx t
podman cp "$WORK/." "$PG:/tmp/evidence" >/dev/null
podman exec -u 0 "$PG" chmod -R a+rX /tmp/evidence
for kind in token string; do for mode in worker import; do for n in 0 1 2; do
 name="$kind-$mode-$n"; id=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).id" "$WORK/$name.meta")
 result=$(podman exec -e PGPASSWORD=dryrun "$PG" psql -X -v ON_ERROR_STOP=1 -U supabase_admin -h 127.0.0.1 -d postgres -Atc "select raw_report_json=pg_read_file('/tmp/evidence/$name.raw') and report=pg_read_file('/tmp/evidence/$name.raw')::jsonb and sha256=encode(sha256(convert_to(raw_report_json,'UTF8')),'hex') from public.seosmith_audits where delivery_id='$id'")
 [[ "$result" = t ]] || { echo "raw/report/hash mismatch: $name" >&2; exit 1; }
done; done; done
echo '12 receipt/raw/report/hash checks passed'
call 200 ingest_seosmith_audit "@$WORK/exact16m.json" ''
call 400 ingest_seosmith_audit "@$WORK/oversize.json" ''
node -e "if(JSON.parse(require('fs').readFileSync(process.argv[1])).message!=='invalid_delivery')process.exit(1)" "$WORK/response"
echo 'exact 16 MiB accepted; 16 MiB + 1 rejected'
