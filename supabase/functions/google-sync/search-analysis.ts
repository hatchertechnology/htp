import type { Json } from "./google.ts";

const day = 86_400_000;
function date(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value
    ? time
    : null;
}
function validRow(row: Json, keys: number): boolean {
  return ((keys === 0 && row.keys === undefined) ||
    (Array.isArray(row.keys) && row.keys.length === keys &&
      row.keys.every((key: unknown) => typeof key === "string"))) &&
    [row.clicks, row.impressions, row.ctr, row.position].every((n) =>
      typeof n === "number" && Number.isFinite(n) && n >= 0
    ) && row.clicks <= row.impressions && row.ctr <= 1;
}
function rows(report: Json, name: string, dimensions: number): Json[] {
  return (Array.isArray(report[name]?.rows) ? report[name].rows : [])
    .filter((row: Json) => row && validRow(row, dimensions));
}
function comparisonReason(current: Json, previous?: Json): string | null {
  if (!previous) return "previous_period_unavailable";
  const starts = [date(previous.start_date), date(current.start_date)];
  const ends = [date(previous.end_date), date(current.end_date)];
  if ([...starts, ...ends].some((value) => value === null)) {
    return "invalid_period";
  }
  const [ps, cs] = starts as number[], [pe, ce] = ends as number[];
  if (pe < ps || ce < cs || pe + day !== cs || pe - ps !== ce - cs) {
    return "periods_not_adjacent_and_equal";
  }
  if (!current.site_url || current.site_url !== previous.site_url) {
    return "different_property";
  }
  const a = current.measurement, b = previous.measurement;
  if (!a || !b || a.version !== 1 || b.version !== 1) {
    return "provenance_unavailable";
  }
  if (a.data_state !== "final" || b.data_state !== "final") {
    return "nonfinal_data";
  }
  if (
    ["source", "search_type", "date_timezone"].some((key) =>
      !a[key] || a[key] !== b[key]
    ) ||
    JSON.stringify(a.filters) !== JSON.stringify(b.filters)
  ) return "different_measurement_policy";
  if (
    a.latest_observed_date !== current.end_date ||
    b.latest_observed_date !== previous.end_date
  ) {
    return "period_freshness_unconfirmed";
  }
  if (
    current.summary?.collection?.truncated !== false ||
    previous.summary?.collection?.truncated !== false
  ) return "summary_coverage_unknown";
  return null;
}

/** Versioned review candidates from retained observations, never causal diagnoses.
 * Query dimensions exclude anonymized queries; bounded top rows are not an inventory.
 */
export function analyzeSearch(
  current: Json,
  previous?: Json,
  conversions?: Json,
): Json {
  const candidates: Json[] = [];
  const pages = rows(current, "pages", 1);
  for (const row of pages) {
    if (row.impressions >= 100 && row.ctr < 0.02) {
      candidates.push({
        kind: row.clicks === 0 ? "zero_click_review" : "low_ctr_review",
        page: row.keys[0],
        source: "search.pages",
        evidence: row,
        interpretation:
          "Observed search response warrants review; intent and result appearance are unknown.",
      });
    }
  }
  const queries = new Map<string, Json[]>();
  for (const row of rows(current, "query_pages", 2)) {
    if (row.impressions < 10) continue;
    const list = queries.get(row.keys[0]) ?? [];
    list.push(row);
    queries.set(row.keys[0], list);
  }
  for (const [query, evidence] of queries) {
    if (new Set(evidence.map((row) => row.keys[1])).size < 2) continue;
    candidates.push({
      kind: "query_page_overlap_review",
      query,
      source: "search.query_pages",
      evidence,
      interpretation:
        "Multiple observed pages share a query; this does not establish harmful competition.",
    });
  }
  const reason = comparisonReason(current, previous);
  const comparison: Json = { available: reason === null, reason };
  if (!reason && previous) {
    const before = rows(previous, "summary", 0)[0];
    const after = rows(current, "summary", 0)[0];
    if (!before || !after) {
      comparison.available = false;
      comparison.reason = "summary_unavailable";
    } else {
      comparison.previous_period = {
        start_date: previous.start_date,
        end_date: previous.end_date,
      };
      comparison.clicks = {
        before: before.clicks,
        after: after.clicks,
        delta: after.clicks - before.clicks,
        relative_change: before.clicks > 0
          ? (after.clicks - before.clicks) / before.clicks
          : null,
      };
      if (before.clicks >= 20 && after.clicks <= before.clicks * 0.8) {
        candidates.push({
          kind: "traffic_decay_review",
          source: "search.summary",
          evidence: { before, after },
          interpretation:
            "Observed clicks fell at least 20%; seasonality and cause require review.",
        });
      }
    }
  }
  const landingOutcomes: Json = {
    available: false,
    reason: "conversion_report_unavailable",
    rows: [],
  };
  if (conversions) {
    if (
      !current.measurement?.filters?.hostname ||
      conversions.fqdn !== current.measurement.filters.hostname
    ) {
      landingOutcomes.reason = "different_or_unknown_hostname";
    } else if (
      conversions.start_date !== current.start_date ||
      conversions.end_date !== current.end_date
    ) {
      landingOutcomes.reason = "different_or_unknown_period";
    } else if (
      conversions.pages?.metadata?.subjectToThresholding ||
      conversions.pages?.metadata?.samplingMetadatas?.length
    ) {
      landingOutcomes.reason = "thresholded_or_sampled";
    } else {
      const report = conversions.pages;
      const names = report?.metricHeaders?.map((header: Json) => header.name);
      const required = [
        "sessions",
        "keyEvents",
        "totalRevenue",
        "sessionKeyEventRate",
      ];
      if (
        Array.isArray(names) && required.every((name) =>
          names.includes(name)
        ) &&
        report?.dimensionHeaders?.[0]?.name === "landingPagePlusQueryString" &&
        Array.isArray(report.rows)
      ) {
        landingOutcomes.available = true;
        landingOutcomes.reason = null;
        landingOutcomes.coverage = "bounded_provider_rows";
        const rowCount = typeof report.rowCount === "number" &&
            Number.isSafeInteger(report.rowCount) &&
            report.rowCount >= report.rows.length
          ? report.rowCount
          : null;
        landingOutcomes.collection = {
          row_count: rowCount,
          returned_rows: report.rows.length,
          truncated: rowCount === null ? null : rowCount > report.rows.length,
        };
        landingOutcomes.attribution =
          "All collected channels; no attribution to individual search queries.";
        landingOutcomes.rows = report.rows.flatMap((row: Json) => {
          const landing = row.dimensionValues?.[0]?.value;
          const values = row.metricValues?.map((metric: Json) =>
            typeof metric.value === "string" && metric.value.trim() !== ""
              ? Number(metric.value)
              : NaN
          );
          if (
            typeof landing !== "string" || !Array.isArray(values) ||
            values.length !== names.length ||
            values.some((value: number, i: number) =>
              !Number.isFinite(value) ||
              (value < 0 && names[i] !== "totalRevenue")
            )
          ) return [];
          return [{
            landing_page: landing,
            metrics: Object.fromEntries(
              names.map((name: string, i: number) => [name, values[i]]),
            ),
            evidence: row,
          }];
        });
        if (
          landingOutcomes.rows.length !== report.rows.length ||
          report.rows.length === 0
        ) {
          landingOutcomes.available = false;
          landingOutcomes.reason = report.rows.length === 0
            ? "landing_rows_unavailable"
            : "invalid_landing_rows";
          landingOutcomes.rows = [];
        }
      } else landingOutcomes.reason = "landing_metrics_unavailable";
    }
  }
  return {
    semantics_version: 1,
    policy: {
      min_impressions: 100,
      low_ctr_below: 0.02,
      decay_fraction: 0.2,
      decay_min_previous_clicks: 20,
      overlap_min_impressions_per_page: 10,
    },
    period: { start_date: current.start_date, end_date: current.end_date },
    coverage: {
      scope: "retained_observations_only",
      provider_completeness: "not_guaranteed",
      anonymized_queries: "excluded",
      truncated: current.pages?.collection?.truncated ?? null,
    },
    comparison,
    candidates,
    landing_outcomes: landingOutcomes,
  };
}
