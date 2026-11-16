# Bing dashboard browser fixture

This client-side fixture mounts the production `BingDashboard.vue` and `ReportSyncNotice.vue` with a mocked authenticated workspace and post-RPC data. The chart and unrelated UI components are stubs. No provider or customer session is used.

Start `npx vite --config tests/fixtures/vite.config.mjs` from `apps/web`, then run `apps/web/tests/fixtures/check-bing-dashboard.sh` from the repository root with `playwright-cli` on PATH. The script checks disconnected partial coverage, latest collection failure with retained rows, retained source after no-match, and a newly bound source. The SQL tests separately check that those post-RPC no-match and rebind responses are produced without mixing properties.
