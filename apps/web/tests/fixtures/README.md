# Bing dashboard browser fixture

This client-side fixture mounts the production `BingDashboard.vue` and `ReportSyncNotice.vue` with a mocked authenticated workspace and post-RPC data. The chart and unrelated UI components are stubs. No provider or customer session is used. SQL tests separately check the no-match and rebind responses and source isolation.

From `apps/web`, run `npm ci` and `npx playwright install chromium` once. Start the fixture with `npm run fixture:bing:serve`, then in another terminal run `npm run fixture:bing:check`. Both commands use the project-local, lockfile-pinned Playwright package. Set `BING_FIXTURE_PORT=4181` on the server and `BING_FIXTURE_BASE_URL=http://127.0.0.1:4181` on the checker to use another port. The checker waits for each rendered state and asserts exact clicks and impressions, the missing date, status, and property rebinding.

# Forms inbox browser fixture

Run `npm run fixture:forms:serve`, then `npm run fixture:forms:check` in another terminal. It mounts the actual forms component with synthetic data and checks desktop/mobile response rendering, escaping and export availability. It does not exercise a hosted backend.
