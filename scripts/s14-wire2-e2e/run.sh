#!/usr/bin/env bash
# Candidate crawls using pre-provisioned dedicated local services. See README.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?output directory}
: "${FIXTURE_WEBSITE_ID:?}" "${REAL_WEBSITE_ID:?}" "${SEOSMITH_API_TOKEN:?}" "${ADMIT:?}" "${DB_CONTAINER:?}"
fixture_url=${FIXTURE_SEO_URL:-http://127.0.0.1:8967}
real_url=${REAL_SEO_URL:-http://127.0.0.1:8968}
mkdir -p "$out"
fail=0
for n in 400 250 128; do
  SEO_URL=$fixture_url WEBSITE_ID=$FIXTURE_WEBSITE_ID "$here/crawl.sh" https://fixture.example/ "$n" "$out/fixture-$n" || fail=1
done
# Never overlap real crawls. Each uses the producer's >= 1000 ms delay.
for n in 400 250 128; do
  SEO_URL=$real_url WEBSITE_ID=$REAL_WEBSITE_ID "$here/crawl.sh" https://www.kerryhatcher.com/ "$n" "$out/real-$n" || fail=1
done
exit "$fail"
