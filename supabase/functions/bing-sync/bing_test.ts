// deno-lint-ignore-file require-await
import { strict as assert } from "node:assert";
import { createCipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  bing,
  BingError,
  fetchReport,
  type Job,
  refreshToken,
  validSite,
} from "./bing.ts";
import { authorized, openGrant, sealGrant } from "./crypto.ts";
import { runSync } from "./worker.ts";
import { handle } from "./index.ts";
const key = Buffer.alloc(32, 7).toString("base64");
const config = { key, clientId: "client", clientSecret: "secret" };
const job: Job = {
  id: "job",
  lease: "lease",
  generation: "generation",
  owner_id: "owner",
  encrypted_grant: "",
  fqdn: "example.com",
};
Deno.test("Bing encryption interoperates with Nuxt and binds grants to the owner and provider", async () => {
  const iv = Buffer.alloc(12, 2),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  cipher.setAAD(Buffer.from("htp_bing_grant:owner"));
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify({ user: "owner", refresh: "private" })),
    cipher.final(),
  ]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString(
    "base64url",
  );
  assert.equal((await openGrant(sealed, key, "owner")).refresh, "private");
  await assert.rejects(() => openGrant(sealed, key, "other"));
  const reSealed = await sealGrant({ user: "owner", refresh: "rotated" }, key);
  assert.equal((await openGrant(reSealed, key, "owner")).refresh, "rotated");
  assert.equal(await authorized("same", "same"), true);
  assert.equal(await authorized(null, "same"), false);
});
Deno.test("only verified exact root properties are collected, HTTPS wins, and discovery secrets are removed", async () => {
  const seen: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    seen.push(u.pathname);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer access",
    );
    assert.equal(init?.redirect, "error");
    if (u.pathname.endsWith("GetUserSites")) {
      return Response.json({
        d: [
          {
            Url: "https://other.com",
            IsVerified: true,
            AuthenticationCode: "private",
          },
          { Url: "https://example.com/path", IsVerified: true },
          { Url: "https://example.com", IsVerified: false },
          { Url: "http://example.com", IsVerified: true },
          {
            Url: "https://example.com/",
            IsVerified: true,
            AuthenticationCode: "private",
          },
        ],
      });
    }
    assert.equal(u.searchParams.get("siteUrl"), "https://example.com/");
    if (u.pathname.endsWith("GetCrawlIssues")) {
      return Response.json({ ErrorCode: 5, Message: "private error body" }, {
        status: 400,
      });
    }
    return Response.json({
      d: [{ Date: "/Date(1316156400000-0700)/", Clicks: 2, Impressions: 20 }],
    });
  };
  const report = await fetchReport(job, "access", fetcher);
  assert.equal(report.site_url, "https://example.com/");
  assert.equal(report.sites.length, 2);
  assert(!JSON.stringify(report).includes("private"));
  assert.equal(report.sections.issues.error, "bing_quota_exceeded");
  assert.equal(report.sections.traffic.rows?.[0].Clicks, 2);
  assert.equal(seen.length, 7);
  for (
    const bad of [
      "https://example.com.evil/",
      "https://sub.example.com/",
      "https://example.com/path",
      "https://user@example.com/",
      "https://example.com:444/",
      "ftp://example.com/",
    ]
  ) assert.equal(validSite(bad, "example.com"), false);
});
Deno.test("no matching verified site is a successful empty discovery observation", async () => {
  let calls = 0;
  const report = await fetchReport(job, "access", async () => {
    calls++;
    return Response.json({ d: [] });
  });
  assert.equal(calls, 1);
  assert.equal(report.site_url, null);
});
Deno.test("API faults, malformed responses, and token refresh failures are sanitized", async () => {
  for (
    const [fault, code] of [
      [3, "bing_authorization_required"],
      [4, "bing_quota_exceeded"],
      [5, "bing_quota_exceeded"],
      [14, "bing_access_denied"],
      [7, "invalid_report"],
    ] as const
  ) {
    await assert.rejects(
      () =>
        bing(
          "GetUserSites",
          "access",
          null,
          async () => Response.json({ ErrorCode: fault, Message: "private" }),
        ),
      (e: unknown) => e instanceof BingError && e.code === code,
    );
  }
  await assert.rejects(() =>
    bing("GetUserSites", "access", null, async () => Response.json({ d: {} }))
  );
  await assert.rejects(
    () =>
      refreshToken(
        "refresh",
        config,
        async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      ),
    (e: unknown) =>
      e instanceof BingError && e.code === "bing_authorization_required",
  );
  const token = await refreshToken("refresh", config, async (url, init) => {
    assert.equal(String(url), "https://www.bing.com/webmasters/oauth/token");
    assert.equal(
      (init?.body as URLSearchParams).get("grant_type"),
      "refresh_token",
    );
    return Response.json({ access_token: "access", refresh_token: "rotated" });
  });
  assert.deepEqual(token, { access: "access", refresh: "rotated" });
});
Deno.test("worker persists rotated refresh tokens, fences writes, and does not log secrets", async () => {
  const encrypted_grant = await sealGrant(
    { user: "owner", refresh: "old" },
    key,
  );
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  let claims = 0;
  const rpc = async (name: string, body: Record<string, unknown>) => {
    calls.push({ name, body });
    if (name === "claim_bing_report") {
      return claims++ === 0 ? { ...job, encrypted_grant } : null;
    }
    return true;
  };
  const result = await runSync(
    rpc,
    config,
    async (input) =>
      String(input).endsWith("/oauth/token")
        ? Response.json({ access_token: "access", refresh_token: "new" })
        : Response.json({ d: [] }),
  );
  assert.equal(result.completed, 1);
  const rotated = calls.find((c) => c.name === "rotate_bing_grant")!;
  assert.equal(rotated.body.p_generation, "generation");
  assert.equal(
    (await openGrant(rotated.body.p_encrypted_grant as string, key, "owner"))
      .refresh,
    "new",
  );
  const completion = calls.find((c) => c.name === "complete_bing_report")!;
  assert.equal(completion.body.p_lease, "lease");
  assert.equal(completion.body.p_error, null);
  assert(!JSON.stringify(completion).includes("refresh"));
});
Deno.test("worker marks invalid refresh grants and secret protection rejects public requests", async () => {
  const encrypted_grant = await sealGrant(
    { user: "owner", refresh: "old" },
    key,
  );
  let claimed = false;
  let error;
  const rpc = async (name: string, body: Record<string, unknown>) => {
    if (name === "claim_bing_report") {
      if (claimed) return null;
      claimed = true;
      return { ...job, encrypted_grant };
    }
    error = body.p_error;
    return true;
  };
  const result = await runSync(
    rpc,
    config,
    async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
  );
  assert.equal(error, "bing_authorization_required");
  assert.equal(result.failed, 1);
  assert.equal(
    (await handle(new Request("https://example.invalid", { method: "GET" })))
      .status,
    405,
  );
  assert.equal(
    (await handle(new Request("https://example.invalid", { method: "POST" })))
      .status,
    401,
  );
});

Deno.test("HTTP authentication and throttling failures work even without JSON bodies", async () => {
  for (
    const [status, code] of [[401, "bing_authorization_required"], [
      429,
      "bing_quota_exceeded",
    ]] as const
  ) {
    await assert.rejects(
      () =>
        bing(
          "GetUserSites",
          "access",
          null,
          async () => new Response("upstream unavailable", { status }),
        ),
      (e: unknown) => e instanceof BingError && e.code === code,
    );
  }
});

Deno.test("failed refresh-token fencing discards work without saving a stale report", async () => {
  const encrypted_grant = await sealGrant(
    { user: "owner", refresh: "old" },
    key,
  );
  let claimed = false;
  const calls: string[] = [];
  const rpc = async (name: string) => {
    calls.push(name);
    if (name === "claim_bing_report") {
      if (claimed) return null;
      claimed = true;
      return { ...job, encrypted_grant };
    }
    return false;
  };
  const result = await runSync(
    rpc,
    config,
    async () => Response.json({ access_token: "access", refresh_token: "new" }),
  );
  assert.equal(result.discarded, 1);
  assert(!calls.includes("complete_bing_report"));
});

Deno.test("Bing www aliases match the registered root, with exact hostnames preferred", async () => {
  assert.equal(validSite("http://example.com/", "www.example.com"), true);
  assert.equal(validSite("https://www.example.com/", "example.com"), true);
  assert.equal(
    validSite("https://other.example.com/", "www.example.com"),
    false,
  );
  let selected = "";
  const report = await fetchReport(
    { ...job, fqdn: "www.example.com" },
    "access",
    async (input) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("GetUserSites")) {
        return Response.json({
          d: [{ Url: "https://example.com/", IsVerified: true }, {
            Url: "http://www.example.com/",
            IsVerified: true,
          }],
        });
      }
      selected = u.searchParams.get("siteUrl")!;
      return Response.json({ d: [] });
    },
  );
  assert.equal(selected, "http://www.example.com/");
  assert.equal(report.site_url, selected);
});
