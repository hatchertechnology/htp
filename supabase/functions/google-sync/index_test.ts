import { handle } from "./index.ts";
Deno.test("updater requires its private Cron secret before accessing configuration or the database", async () => {
  Deno.env.set("GOOGLE_SYNC_SECRET", "private-test-secret");
  try {
    const cases: Record<string, string>[] = [{}, {
      Authorization: "Bearer user-or-public-key",
    }, { "x-htp-sync-secret": "wrong" }];
    for (const headers of cases) {
      const response = await handle(
        new Request("https://example.test/google-sync", {
          method: "POST",
          headers,
        }),
      );
      if (response.status !== 401) {
        throw new Error("Unauthorized updater request was accepted");
      }
    }
    const response = await handle(
      new Request("https://example.test/google-sync", {
        headers: { "x-htp-sync-secret": "private-test-secret" },
      }),
    );
    if (response.status !== 405) throw new Error("Updater must be POST-only");
    Deno.env.delete("GOOGLE_SYNC_SECRET");
    const missing = await handle(
      new Request("https://example.test/google-sync", {
        method: "POST",
        headers: { "x-htp-sync-secret": "private-test-secret" },
      }),
    );
    if (missing.status !== 401) {
      throw new Error("Updater must fail closed when no secret is configured");
    }
  } finally {
    Deno.env.delete("GOOGLE_SYNC_SECRET");
  }
});
