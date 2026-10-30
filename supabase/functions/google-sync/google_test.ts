// Fetch and RPC stubs deliberately implement asynchronous interfaces.
// deno-lint-ignore-file require-await
import { createCipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import { authorized, openGrant, sealGrant } from "./crypto.ts";
import {
  fetchReport,
  type Job,
  refreshToken,
  validProperty,
} from "./google.ts";
import { runSync } from "./worker.ts";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(callback: () => Promise<unknown>, code?: string) {
  try {
    await callback();
  } catch (error) {
    if (code) assert((error as { code: string }).code === code);
    return;
  }
  throw new Error("Expected rejection");
}
const secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const job: Job = {
  id: "job",
  lease: "lease",
  generation: "generation",
  owner_id: "owner",
  encrypted_grant: "",
  website_id: "site",
  fqdn: "www.example.com",
  kind: "analytics",
  property_id: "123",
  start_date: "2026-10-01",
  end_date: "2026-10-27",
};
Deno.test("Edge crypto interoperates with Nuxt AES-GCM and rejects wrong owners and tampering", async () => {
  const grant = { user: "owner", refresh: "private-refresh" };
  const iv = Buffer.alloc(12, 2),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "base64"), iv);
  cipher.setAAD(Buffer.from("htp_google_grant:owner"));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(grant)),
    cipher.final(),
  ]);
  const legacy = Buffer.concat([iv, cipher.getAuthTag(), data]).toString(
    "base64url",
  );
  assert((await openGrant(legacy, secret, "owner")).refresh === grant.refresh);
  const sealed = await sealGrant(grant, secret);
  assert((await openGrant(sealed, secret, "owner")).refresh === grant.refresh);
  await rejects(() => openGrant(sealed, secret, "other"));
  const bytes = Buffer.from(sealed, "base64url");
  bytes[30] ^= 1;
  await rejects(() => openGrant(bytes.toString("base64url"), secret, "owner"));
  assert(await authorized("secret", "secret"));
  assert(!await authorized("bad", "secret"));
  assert(!await authorized(null, ""));
});
Deno.test("GA4 persists original aggregate metrics and exact-host reports", async () => {
  let calls = 0;
  const fetcher = (async (url, options) => {
    calls++;
    assert(
      String(url) ===
        "https://analyticsdata.googleapis.com/v1beta/properties/123:batchRunReports",
    );
    assert(
      (options?.headers as Record<string, string>).Authorization ===
        "Bearer token",
    );
    assert(options?.redirect === "error");
    const { requests } = JSON.parse(String(options?.body));
    assert(requests.length === 5 && !requests[0].dimensions);
    assert(
      requests.every((
        r: { dimensionFilter: { filter: { stringFilter: { value: string } } } },
      ) => r.dimensionFilter.filter.stringFilter.value === "www.example.com"),
    );
    assert(requests[2].dimensions[0].name === "pagePathPlusQueryString");
    return Response.json({
      reports: [{
        metricHeaders: [{ name: "activeUsers" }],
        rows: [{ metricValues: [{ value: "8" }] }],
      }, ...Array.from({ length: 4 }, () => ({ metricHeaders: [] }))],
    });
  }) as typeof fetch;
  const result = await fetchReport(job, "token", fetcher);
  assert(calls === 1 && result.summary.rows[0].metricValues[0].value === "8");
  const empty = await fetchReport(
    job,
    "token",
    (async () =>
      Response.json({
        reports: [
          { kind: "analyticsData#runReport" },
          ...Array.from({ length: 4 }, () => ({ metricHeaders: [] })),
        ],
      })) as typeof fetch,
  );
  assert(empty.summary.metricHeaders[0].name === "activeUsers");
  await rejects(
    () =>
      fetchReport(
        job,
        "token",
        (async () =>
          Response.json({
            reports: [
              { kind: "analyticsData#runReport", rows: [{}] },
              ...Array.from({ length: 4 }, () => ({ metricHeaders: [] })),
            ],
          })) as typeof fetch,
      ),
    "google_unavailable",
  );
});
Deno.test("Search preserves separate totals, finalized data, hostname filters and bounded top rows", async () => {
  const requests: { dimensions: string[]; rowLimit: number }[] = [];
  const result = await fetchReport(
    { ...job, kind: "search", property_id: "sc-domain:example.com" },
    "token",
    (async (url, options) => {
      assert(
        String(url).includes(
          "/sites/sc-domain%3Aexample.com/searchAnalytics/query",
        ),
      );
      const body = JSON.parse(String(options?.body));
      requests.push(body);
      assert(body.dataState === "final" && body.type === "web");
      assert(
        body.dimensionFilterGroups[0].filters[0].expression ===
          "^https?://www\\.example\\.com(:[0-9]+)?/",
      );
      return Response.json({
        rows: [{ clicks: body.dimensions.length ? 10 : 12 }],
      });
    }) as typeof fetch,
  );
  assert(requests.length === 4 && result.summary.rows[0].clicks === 12);
  assert(requests.find((r) => r.dimensions[0] === "query")?.rowLimit === 10);
  assert(validProperty("sc-domain:example.com", "www.example.com"));
  assert(!validProperty("sc-domain:example.com", "badexample.com"));
  assert(!validProperty("https://other.com/", "www.example.com"));
  assert(!validProperty("https://user@www.example.com/", "www.example.com"));
});
Deno.test("property discovery excludes unrelated and unverified properties", async () => {
  const result = await fetchReport(
    { ...job, kind: "properties" },
    "token",
    (async () =>
      Response.json({
        siteEntry: [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
          {
            siteUrl: "https://www.example.com/",
            permissionLevel: "siteUnverifiedUser",
          },
          { siteUrl: "https://other.com/", permissionLevel: "siteOwner" },
        ],
      })) as typeof fetch,
  );
  assert(result.properties.length === 1);
});
Deno.test("OAuth revocation and quota failures produce sanitized retry codes", async () => {
  await rejects(
    () =>
      refreshToken(
        "private",
        "client",
        "secret",
        (async () =>
          Response.json({
            error: "invalid_grant",
            error_description: "private details",
          }, { status: 400 })) as typeof fetch,
      ),
    "google_authorization_required",
  );
  await rejects(
    () =>
      fetchReport(
        job,
        "token",
        (async () =>
          Response.json({
            error: {
              message: "private",
              errors: [{ reason: "dailyLimitExceeded" }],
            },
          }, { status: 403 })) as typeof fetch,
      ),
    "google_quota_exceeded",
  );
});
Deno.test("worker persists success, sanitized failures, and discards fenced completions", async () => {
  const encrypted_grant = await sealGrant(
    { user: "owner", refresh: "private" },
    secret,
  );
  for (const failed of [false, true]) {
    const writes: Record<string, unknown>[] = [];
    let claimed = false;
    const rpc = async (name: string, body: Record<string, unknown>) => {
      if (name === "claim_google_report") {
        if (claimed) return null;
        claimed = true;
        return { ...job, encrypted_grant };
      }
      writes.push(body);
      return true;
    };
    const fetcher = (async (url) => {
      if (String(url).endsWith("/token")) {
        return failed
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json({ access_token: "short" });
      }
      return Response.json({
        reports: Array.from({ length: 5 }, () => ({ metricHeaders: [] })),
      });
    }) as typeof fetch;
    const result = await runSync(rpc, {
      key: secret,
      clientId: "client",
      clientSecret: "secret",
    }, fetcher);
    assert(
      writes.length === 1 && writes[0].p_lease === job.lease &&
        writes[0].p_generation === job.generation,
    );
    if (failed) {
      assert(
        result.failed === 1 &&
          writes[0].p_error === "google_authorization_required" &&
          writes[0].p_data === null,
      );
    } else assert(result.completed === 1 && writes[0].p_data !== null);
    assert(!JSON.stringify(result).includes("private"));
  }
});
