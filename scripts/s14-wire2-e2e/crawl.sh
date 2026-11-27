#!/usr/bin/env bash
# Submit a bounded crawl to an already-running LOCAL SEOsmith and verify the
# resulting report against the local receiver. Credentials stay in the caller's environment.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
url=${1:?seed URL}; resources=${2:?resource bound}; out=${3:?output directory}
: "${SEOSMITH_API_TOKEN:?}" "${WEBSITE_ID:?}" "${ADMIT:?}"
seo=${SEO_URL:-http://127.0.0.1:8967}
[[ $seo == http://127.0.0.1:* ]] || { echo 'SEO_URL must be loopback' >&2; exit 2; }
case "$url" in https://www.kerryhatcher.com/|https://fixture.example/) ;; *) echo 'seed not permitted' >&2; exit 2 ;; esac
case "$resources" in 128|250|400) ;; *) echo 'invalid candidate bound' >&2; exit 2 ;; esac
mkdir -p "$out"
id=$(cat /proc/sys/kernel/random/uuid)
payload=$(jq -nc --arg id "$id" --arg website "$WEBSITE_ID" --arg url "$url" --argjson resources "$resources" '{request_id:$id,website_id:$website,binding_generation:1,url:$url,max_pages:100,max_resources:$resources,check_external_links:false,delay_ms:1000,max_duration_seconds:7200}')
curl -fsS "$seo/v1/runs" -H "authorization: Bearer $SEOSMITH_API_TOKEN" -H 'content-type: application/json' -d "$payload" > "$out/submit.json"
printf '%s\n' "$id" > "$out/request-id"
for ((i=0; i<7500; i++)); do
  curl -fsS "$seo/v1/runs/$id" -H "authorization: Bearer $SEOSMITH_API_TOKEN" > "$out/state.json"
  state=$(jq -r 'if .state == "failed" then "failed" else .delivery_state end' "$out/state.json")
  case "$state" in delivered) break ;; rejected|failed) cat "$out/state.json" >&2; exit 1 ;; esac
  sleep 1
done
[[ $state == delivered ]] || { echo 'crawl timed out' >&2; exit 1; }
curl -fsS "$seo/v1/runs/$id/report" -H "authorization: Bearer $SEOSMITH_API_TOKEN" > "$out/report.json"
/usr/bin/time -f '%e' -o "$out/admit-seconds.txt" "$ADMIT" "$out/report.json" > "$out/summary.json" 2> "$out/admit.log"
measure_rc=0
"$here/measure.py" "$out/report.json" > "$out/measure.json" || measure_rc=$?
# Check exact retained report and summary against the local database receipt.
[[ ${DB_CONTAINER:-} == supabase_db_w1c8e ]] || { echo 'set DB_CONTAINER to the dedicated local test database' >&2; exit 2; }
receipt=$(podman exec "$DB_CONTAINER" psql -U postgres -d postgres -X -q -tA -v ON_ERROR_STOP=1 -c "select sha256 || ' ' || validator_revision from public.seosmith_audits where delivery_id='$id'")
sha=$(sha256sum "$out/report.json" | cut -d' ' -f1)
[[ "$receipt" == "$sha s14-wire-2/full-population-1/evidence-v1/families-v1" ]] || { echo "receipt mismatch: $receipt" >&2; exit 1; }
podman exec "$DB_CONTAINER" psql -U postgres -d postgres -X -q -tA -v ON_ERROR_STOP=1 -c "select summary_text from public.seosmith_audits where delivery_id='$id'" > "$out/stored-summary.newline"
python3 - "$out/stored-summary.newline" "$out/summary.json" <<'PYCODE'
import pathlib, sys
stored = pathlib.Path(sys.argv[1]).read_bytes()
assert stored.endswith(b'\n') and stored[:-1] == pathlib.Path(sys.argv[2]).read_bytes(), 'stored summary differs from admit'
PYCODE
printf '%s\n' "$receipt" > "$out/receipt.txt"
exit "$measure_rc"
