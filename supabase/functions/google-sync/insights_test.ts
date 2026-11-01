// Provider stubs deliberately use asynchronous fetch-compatible interfaces.
// deno-lint-ignore-file require-await
import { canonical, fetchInsight } from "./insights.ts";
import { fetchReport, type Job } from "./google.ts";
import { runSync } from "./worker.ts";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const job: Job = {
  id: "job",
  lease: "lease",
  generation: "generation",
  owner_id: "owner",
  encrypted_grant: "unused",
  website_id: "site",
  fqdn: "example.com",
  kind: "pagespeed",
  property_id: "mobile",
  start_date: "2026-10-01",
  end_date: "2026-10-28",
};
Deno.test("PageSpeed uses fixed homepage, device and full audit categories, without OAuth", async () => {
  const result = await fetchInsight(
    job,
    "",
    { pagespeedKey: "test-key" },
    (async (input, options) => {
      const url = new URL(String(input));
      assert(
        url.origin === "https://www.googleapis.com" &&
          url.searchParams.get("url") === "https://example.com/",
      );
      assert(
        url.searchParams.get("strategy") === "mobile" &&
          url.searchParams.getAll("category").length === 4,
      );
      assert(
        !(options?.headers as Record<string, string> | undefined)
          ?.Authorization,
      );
      return Response.json({
        lighthouseResult: {
          categories: { performance: { score: 0.6 } },
          audits: {
            "render-blocking-insight": { score: 0 },
            "final-screenshot": { details: "large" },
          },
          fullPageScreenshot: "large",
        },
      });
    }) as typeof fetch,
  );
  assert(result.lighthouseResult.audits["render-blocking-insight"].score === 0);
  assert(!result.lighthouseResult.audits["final-screenshot"]);
  assert(!result.lighthouseResult.fullPageScreenshot);
});
Deno.test("CrUX preserves collection period and treats absent traffic as a successful observation", async () => {
  for (const absent of [false, true]) {
    const result = await fetchInsight(
      { ...job, kind: "crux", property_id: "PHONE" },
      "",
      { cruxKey: "test" },
      (async (url, options) => {
        assert(
          String(url).startsWith(
            "https://chromeuxreport.googleapis.com/v1/records:queryRecord",
          ),
        );
        const body = JSON.parse(String(options?.body));
        assert(
          body.origin === "https://example.com" && body.formFactor === "PHONE",
        );
        return absent
          ? Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 })
          : Response.json({
            record: {
              collectionPeriod: {
                firstDate: { year: 2026, month: 10, day: 1 },
              },
              metrics: {
                cumulative_layout_shift: { percentiles: { p75: "0.03" } },
              },
            },
          });
      }) as typeof fetch,
    );
    assert(result.available === !absent);
    if (!absent) {
      assert(
        result.record.metrics.cumulative_layout_shift.percentiles.p75 ===
          "0.03",
      );
    }
  }
});
Deno.test("Business location discovery paginates accounts and locations and deduplicates resources", async () => {
  let calls = 0;
  const result = await fetchInsight(
    { ...job, kind: "business_locations", property_id: "" },
    "token",
    {},
    (async (input, options) => {
      calls++;
      const url = new URL(String(input));
      assert(
        (options?.headers as Record<string, string>).Authorization ===
          "Bearer token",
      );
      if (url.hostname === "mybusinessaccountmanagement.googleapis.com") {
        return Response.json({
          accounts: [{
            name: url.searchParams.has("pageToken")
              ? "accounts/2"
              : "accounts/1",
          }],
          ...(url.searchParams.has("pageToken")
            ? {}
            : { nextPageToken: "second" }),
        });
      }
      if (url.pathname.includes("accounts/2")) {
        return Response.json({
          locations: [{ name: "locations/10", title: "Store" }],
        });
      }
      assert(url.searchParams.get("readMask")?.includes("title"));
      return Response.json({
        locations: [{
          name: url.searchParams.has("pageToken")
            ? "locations/11"
            : "locations/10",
          title: "Store",
        }],
        ...(url.searchParams.has("pageToken")
          ? {}
          : { nextPageToken: "second" }),
      });
    }) as typeof fetch,
  );
  assert(calls === 5 && result.locations.length === 2);
});
Deno.test("Business profile records attributes and stable unordered fields but preserves address ordering", async () => {
  const result = await fetchInsight(
    { ...job, kind: "business_profile", property_id: "locations/10" },
    "token",
    {},
    (async (input) => {
      const url = new URL(String(input));
      return Response.json(
        url.pathname.endsWith("/attributes")
          ? {
            attributes: [{ name: "b", values: [true] }, {
              name: "a",
              values: [false],
            }],
          }
          : {
            name: "locations/10",
            title: "Store",
            labels: ["z", "a"],
            storefrontAddress: { addressLines: ["Z Street", "A Suite"] },
          },
      );
    }) as typeof fetch,
  );
  assert(
    result.location.labels[0] === "a" &&
      result.location.attributes[0].name === "a",
  );
  assert(result.location.storefrontAddress.addressLines[0] === "Z Street");
  assert(
    JSON.stringify(canonical({ labels: ["a", "z"] })) ===
      JSON.stringify(canonical({ labels: ["z", "a"] })),
  );
});
Deno.test("Business daily metrics use inclusive provider dates and preserve missing/zero values", async () => {
  const result = await fetchInsight(
    { ...job, kind: "business_performance", property_id: "locations/10" },
    "token",
    {},
    (async (input) => {
      const url = new URL(String(input));
      assert(
        url.pathname.endsWith("/locations/10:fetchMultiDailyMetricsTimeSeries"),
      );
      assert(
        url.searchParams.get("dailyRange.endDate.day") === "28" &&
          url.searchParams.getAll("dailyMetrics").includes("CALL_CLICKS"),
      );
      return Response.json({
        multiDailyMetricTimeSeries: [{
          dailyMetricTimeSeries: [{
            dailyMetric: "CALL_CLICKS",
            timeSeries: {
              datedValues: [{
                date: { year: 2026, month: 10, day: 1 },
                value: "0",
              }],
            },
          }],
        }],
      });
    }) as typeof fetch,
  );
  assert(
    result.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries[0].timeSeries
      .datedValues[0].value === "0",
  );
});
Deno.test("Conversion reports request aggregate rates, daily outcomes, landing pages, channels and event names in one bounded batch", async () => {
  const result = await fetchReport(
    { ...job, kind: "conversions", property_id: "123" },
    "token",
    (async (_, options) => {
      const { requests } = JSON.parse(String(options?.body));
      assert(requests.length === 5 && !requests[0].dimensions);
      assert(
        requests[0].metrics.some((m: { name: string }) =>
          m.name === "sessionKeyEventRate"
        ),
      );
      assert(
        requests[2].dimensions[0].name === "landingPagePlusQueryString" &&
          requests[4].dimensions[0].name === "eventName",
      );
      assert(
        requests.every((
          r: {
            dimensionFilter: { filter: { stringFilter: { value: string } } };
          },
        ) => r.dimensionFilter.filter.stringFilter.value === "example.com"),
      );
      return Response.json({
        reports: requests.map(() => ({
          metricHeaders: [{ name: "keyEvents" }],
          rows: [],
        })),
      });
    }) as typeof fetch,
  );
  assert(result.events && !result.devices);
});
Deno.test("Public-key failures never revoke OAuth and public jobs do not decrypt a grant or refresh tokens", async () => {
  for (const keys of [{}, { pagespeedKey: "invalid" }]) {
    let claimed = false;
    let writes: Record<string, unknown> = {};
    const result = await runSync(
      async (name, body) => {
        if (name === "claim_google_report") {
          if (claimed) return null;
          claimed = true;
          return job;
        }
        writes = body;
        return true;
      },
      { key: "not-needed", clientId: "", clientSecret: "", ...keys },
      (async (input) => {
        assert(String(input).includes("pagespeedonline"));
        return Response.json({ error: { status: "UNAUTHENTICATED" } }, {
          status: 401,
        });
      }) as typeof fetch,
    );
    assert(
      result.failed === 1 && writes.p_error === "integration_not_configured",
    );
  }
});

Deno.test("malformed successful profile responses cannot become false deletion observations", async () => {
  let rejected = false;
  try {
    await fetchInsight(
      { ...job, kind: "business_profile", property_id: "locations/10" },
      "token",
      {},
      (async () => Response.json({})) as typeof fetch,
    );
  } catch (error) {
    rejected = (error as { code: string }).code === "google_unavailable";
  }
  assert(rejected);
});

Deno.test("priority page reports retain URL/device/lab provenance and never substitute origin field data", async () => {
  for (const kind of ["pagespeed", "crux"] as const) {
    const device = kind === "pagespeed" ? "desktop" : "DESKTOP";
    const target = "https://example.com/services?area=macon";
    let calls = 0;
    const result = await fetchInsight(
      { ...job, kind, property_id: `${device}|${target}` },
      "",
      { pagespeedKey: "key", cruxKey: "key" },
      (async (input, options) => {
        calls++;
        if (kind === "pagespeed") {
          assert(new URL(String(input)).searchParams.get("url") === target);
          assert(
            new URL(String(input)).searchParams.get("strategy") === device,
          );
          return Response.json({
            lighthouseResult: {
              categories: { performance: { score: 0.8 } },
              lighthouseVersion: "13",
              configSettings: { formFactor: "desktop" },
              audits: { "total-blocking-time": { numericValue: 0 } },
            },
          });
        }
        const body = JSON.parse(String(options?.body));
        assert(
          body.url === target && !body.origin && body.formFactor === device,
        );
        return Response.json({ error: { status: "NOT_FOUND" } }, {
          status: 404,
        });
      }) as typeof fetch,
    );
    assert(
      calls === 1 && result.measurement.target === target &&
        result.measurement.scope === "url",
    );
    assert(
      result.measurement.device === device &&
        result.measurement.semantics_version === 1,
    );
    if (kind === "crux") assert(result.available === false && !result.record);
    else {assert(
        result.measurement.sample_count === 1 &&
          result.measurement.metrics["total-blocking-time"] === 0 &&
          result.measurement.metrics["largest-contentful-paint"] === null,
      );}
  }
});

Deno.test("invalid sampled URLs never reach a provider", async () => {
  for (
    const url of [
      "https://other.example/a",
      "http://example.com/a",
      "https://example.com:8443/a",
      "https://user@example.com/a",
      "https://example.com/a#fragment",
      "https://example.com/a#",
      "https://example.com/a|b",
      "https://example.com/a b",
      "https://example.com:443/a",
    ]
  ) {
    for (const kind of ["pagespeed", "crux"] as const) {
      let called = false;
      try {
        await fetchInsight(
          {
            ...job,
            kind,
            property_id: `${kind === "crux" ? "PHONE" : "mobile"}|${url}`,
          },
          "",
          { pagespeedKey: "key", cruxKey: "key" },
          (async () => {
            called = true;
            return Response.json({});
          }) as typeof fetch,
        );
        throw new Error("Expected rejection");
      } catch (error) {
        assert((error as { code: string }).code === "invalid_report");
      }
      assert(!called);
    }
  }
});
