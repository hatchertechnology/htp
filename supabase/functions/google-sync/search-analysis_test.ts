import { analyzeSearch } from "./search-analysis.ts";
import type { Json } from "./google.ts";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("Assertion failed");
}
const metric = (keys: string[], clicks: number, impressions = 100) => ({
  keys,
  clicks,
  impressions,
  ctr: clicks / impressions,
  position: 5,
});
function report(start = "2026-10-08", end = "2026-10-14"): Json {
  return {
    site_url: "sc-domain:example.com",
    start_date: start,
    end_date: end,
    measurement: {
      version: 1,
      source: "google_search_console",
      search_type: "web",
      data_state: "final",
      date_timezone: "America/Los_Angeles",
      filters: { hostname: "example.com" },
      latest_observed_date: end,
    },
    summary: { collection: { truncated: false }, rows: [metric([], 50)] },
    pages: { collection: { truncated: false }, rows: [] },
    query_pages: { rows: [] },
  };
}
Deno.test("review candidates preserve observed evidence without invented absent rows", () => {
  const current = report();
  current.pages.rows = [
    metric(["https://example.com/low"], 1, 100),
    metric(["https://example.com/zero"], 0, 100),
    metric(["https://example.com/small"], 0, 9),
  ];
  current.query_pages.rows = [
    metric(["service", "https://example.com/a"], 5),
    metric(["service", "https://example.com/b"], 2),
  ];
  const result = analyzeSearch(current);
  assert(result.candidates.length === 3);
  assert(result.candidates[0].evidence === current.pages.rows[0]);
  assert(result.candidates[1].kind === "zero_click_review");
  assert(result.candidates[2].kind === "query_page_overlap_review");
  assert(result.comparison.reason === "previous_period_unavailable");
});
Deno.test("only adjacent equal final periods with equivalent evidence can produce click decay", () => {
  const current = report();
  const previous = report("2026-10-01", "2026-10-07");
  previous.summary.rows = [metric([], 100)];
  let result = analyzeSearch(current, previous);
  assert(
    result.comparison.available &&
      result.comparison.clicks.relative_change === -0.5,
  );
  assert(result.candidates[0].kind === "traffic_decay_review");
  const mutations: ((p: Json) => void)[] = [
    (p) => p.end_date = "2026-10-06",
    (p) => p.measurement.data_state = "all",
    (p) => p.measurement.filters.hostname = "other.example",
    (p) => p.summary.collection.truncated = true,
    (p) => p.measurement.latest_observed_date = "2026-10-06",
    (p) => p.site_url = "sc-domain:other.example",
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(previous);
    mutate(changed);
    result = analyzeSearch(current, changed);
    assert(
      !result.comparison.available &&
        !result.candidates.some((c: Json) => c.kind === "traffic_decay_review"),
    );
  }
});
Deno.test("legacy, malformed and empty observations remain unavailable instead of zero traffic", () => {
  const current = report();
  const previous = report("2026-10-01", "2026-10-07");
  current.summary.rows = [];
  current.pages.rows = [metric(["invalid"], 0, NaN), {
    ...metric(["bad"], 0),
    clicks: -1,
  }];
  const result = analyzeSearch(current, previous);
  assert(
    result.comparison.reason === "summary_unavailable" &&
      result.candidates.length === 0,
  );
  const unavailable = {
    ...previous,
    unavailable: true,
    reason: "previous_period_unavailable",
  };
  assert(
    analyzeSearch(current, unavailable).comparison.reason ===
      "previous_period_unavailable",
  );
  delete current.measurement;
  assert(
    analyzeSearch(current, previous).comparison.reason ===
      "provenance_unavailable",
  );
});
Deno.test("landing outcomes preserve zero values and reject unrelated periods or thresholding", () => {
  const current = report();
  const conversions: Json = {
    fqdn: "example.com",
    start_date: current.start_date,
    end_date: current.end_date,
    pages: {
      dimensionHeaders: [{ name: "landingPagePlusQueryString" }],
      metricHeaders: [
        "sessions",
        "keyEvents",
        "totalRevenue",
        "sessionKeyEventRate",
      ].map((name) => ({ name })),
      rows: [{
        dimensionValues: [{ value: "/service?a=1" }],
        metricValues: [10, 0, 0, 0].map((value) => ({ value: String(value) })),
      }],
    },
  };
  let result = analyzeSearch(current, undefined, conversions);
  assert(
    result.landing_outcomes.available &&
      result.landing_outcomes.rows[0].metrics.keyEvents === 0,
  );
  assert(
    result.landing_outcomes.collection.returned_rows === 1 &&
      result.landing_outcomes.collection.truncated === null,
  );
  // Net totalRevenue subtracts refunds; valid signed revenue is preserved.
  conversions.pages.rows[0].metricValues[2].value = "-25";
  result = analyzeSearch(current, undefined, conversions);
  assert(result.landing_outcomes.available);
  assert(result.landing_outcomes.rows[0].metrics.totalRevenue === -25);
  conversions.pages.rows[0].metricValues[0].value = "-1";
  assert(
    analyzeSearch(current, undefined, conversions).landing_outcomes.reason ===
      "invalid_landing_rows",
  );
  conversions.pages.rows[0].metricValues[0].value = "10";
  conversions.pages.rowCount = 20;
  result = analyzeSearch(current, undefined, conversions);
  assert(
    result.landing_outcomes.collection.row_count === 20 &&
      result.landing_outcomes.collection.truncated === true,
  );
  conversions.pages.rowCount = 1;
  assert(
    analyzeSearch(current, undefined, conversions).landing_outcomes.collection
      .truncated === false,
  );
  conversions.pages.metadata = { subjectToThresholding: true };
  result = analyzeSearch(current, undefined, conversions);
  assert(result.landing_outcomes.reason === "thresholded_or_sampled");
  delete conversions.pages.metadata;
  conversions.fqdn = "other.example";
  assert(
    analyzeSearch(current, undefined, conversions).landing_outcomes.reason ===
      "different_or_unknown_hostname",
  );
  conversions.fqdn = "example.com";
  conversions.pages.rows[0].metricValues[0].value = "";
  assert(
    analyzeSearch(current, undefined, conversions).landing_outcomes.reason ===
      "invalid_landing_rows",
  );
  conversions.pages.rows = [];
  assert(
    analyzeSearch(current, undefined, conversions).landing_outcomes.reason ===
      "landing_rows_unavailable",
  );
  conversions.start_date = "2026-10-01";
  assert(
    analyzeSearch(current, undefined, conversions).landing_outcomes.reason ===
      "different_or_unknown_period",
  );
});

Deno.test("ungrouped Search Console summary rows may omit dimension keys", () => {
  const current = report();
  const previous = report("2026-10-01", "2026-10-07");
  previous.summary.rows = [metric([], 100)];
  delete current.summary.rows[0].keys;
  delete previous.summary.rows[0].keys;
  const result = analyzeSearch(current, previous);
  assert(
    result.comparison.available &&
      result.candidates[0].kind === "traffic_decay_review",
  );
});
