#!/bin/sh
# Start: cd apps/web && npx vite --config tests/fixtures/vite.config.mjs
set -eu
session=htp-bing-fixture-test
playwright-cli -s="$session" open http://127.0.0.1:4177/tests/fixtures/bing-dashboard.html >/dev/null
trap 'playwright-cli -s="$session" close >/dev/null' EXIT
check() {
  result=$(playwright-cli -s="$session" eval "$1")
  printf '%s\n' "$result" | grep -q 'true' || { printf '%s\n' "$result"; exit 1; }
}
check "document.body.innerText.includes('Stored coverage: partial') && document.body.innerText.includes('2026-10-03') && document.body.innerText.includes('Bing clicks') && document.body.innerText.includes('Connect Bing')"
playwright-cli -s="$session" eval "window.setFixture('failure')" >/dev/null
check "document.body.innerText.includes('latest Bing traffic collection failed') && document.body.innerText.includes('Bing clicks') && document.body.innerText.includes('2')"
playwright-cli -s="$session" eval "window.setFixture('no-match')" >/dev/null
check "document.body.innerText.includes('https://example.com/') && document.body.innerText.includes('Bing clicks')"
playwright-cli -s="$session" eval "window.setFixture('rebind')" >/dev/null
check "document.body.innerText.includes('https://new.example.com/') && document.body.innerText.includes('99')"
printf '%s\n' 'Actual BingDashboard rendered disconnected partial, failed collection, no-match retained source, and rebind fixture states.'
