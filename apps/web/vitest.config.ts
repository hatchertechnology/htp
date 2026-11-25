import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '#shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
  // The suite runs in a fixed non-UTC zone (TZ=America/New_York, set by the
  // `test` script). `npm run test:tz-utc` re-runs the time helpers with TZ=UTC as
  // the second-zone cross-check; a `test.env` TZ here would override that.
  // A bare `npx vitest run` inherits the host zone and fails the loud zone
  // assertion in tests/local-time.test.ts — use `npm test`.
})
