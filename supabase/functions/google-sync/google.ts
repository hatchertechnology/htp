import { analyzeSearch } from "./search-analysis.ts";

// Raw provider metadata is deliberately preserved alongside the known fields.
// deno-lint-ignore no-explicit-any
export type Json = Record<string, any>;
export interface Job {
  id: string;
  lease: string;
  generation: string;
  owner_id: string;
  encrypted_grant: string;
  website_id: string;
  fqdn: string;
  kind:
    | "analytics"
    | "search"
    | "properties"
    | "conversions"
    | "pagespeed"
    | "crux"
    | "business_locations"
    | "business_profile"
    | "business_performance";
  property_id: string;
  start_date: string;
  end_date: string;
}
export class SyncError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function validProperty(site: string, host: string): boolean {
  if (site.startsWith("sc-domain:")) {
    const domain = site.slice(10);
    return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) &&
      (domain === host || host.endsWith(`.${domain}`));
  }
  try {
    const url = new URL(site);
    return ["http:", "https:"].includes(url.protocol) &&
      url.hostname === host && !url.username && !url.password && !url.port &&
      !url.search && !url.hash && site.endsWith("/");
  } catch {
    return false;
  }
}
export async function google(
  url: string,
  options: RequestInit,
  fetcher: typeof fetch,
  timeout = 20_000,
  allowNotFound = false,
): Promise<Json> {
  const response = await fetcher(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  const value = await response.json();
  if (
    !response.ok &&
    !(allowNotFound && response.status === 404 &&
      value?.error?.status === "NOT_FOUND")
  ) {
    const reasons = value?.error?.errors ?? [];
    const quota = reasons.some((e: Json) =>
      [
        "quotaExceeded",
        "dailyLimitExceeded",
        "rateLimitExceeded",
        "userRateLimitExceeded",
      ].includes(e.reason)
    );
    throw new SyncError(
      value.error === "invalid_grant" || response.status === 401
        ? "google_authorization_required"
        : response.status === 429 || quota
        ? "google_quota_exceeded"
        : response.status === 403
        ? "google_access_denied"
        : response.status === 400 || response.status === 404
        ? "invalid_report"
        : "google_unavailable",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyncError("google_unavailable");
  }
  return value;
}
export async function refreshToken(
  refresh: string,
  clientId: string,
  clientSecret: string,
  fetcher = fetch,
): Promise<{ access: string; refresh?: string }> {
  const data = await google("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  }, fetcher);
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new SyncError("google_unavailable");
  }
  return { access: data.access_token, refresh: data.refresh_token };
}
export async function fetchReport(
  job: Job,
  access: string,
  fetcher = fetch,
): Promise<Json> {
  const headers = {
    Authorization: `Bearer ${access}`,
    "Content-Type": "application/json",
  };
  if (job.kind === "properties") {
    const result = await google(
      "https://www.googleapis.com/webmasters/v3/sites",
      { headers },
      fetcher,
    );
    return {
      properties: (result.siteEntry ?? []).filter((entry: Json) =>
        typeof entry.siteUrl === "string" &&
        validProperty(entry.siteUrl, job.fqdn) &&
        entry.permissionLevel !== "siteUnverifiedUser"
      ),
    };
  }
  if (job.kind === "search") {
    if (!validProperty(job.property_id, job.fqdn)) {
      throw new SyncError("invalid_report");
    }
    const deadline = AbortSignal.timeout(55_000);
    const boundedFetcher: typeof fetch = (url, options) =>
      fetcher(url, {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([deadline, options.signal])
          : deadline,
      });
    // Keep totals separate: query dimensions omit anonymized queries and the
    // provider only exposes top rows, even when pagination reaches its end.
    const shapes: [string, string[], number][] = [
      ["summary", [], 1],
      ["daily", ["date"], 366],
      ["queries", ["query"], 5000],
      ["pages", ["page"], 5000],
      ["query_pages", ["query", "page"], 5000],
      ["devices", ["device"], 10],
      ["countries", ["country"], 300],
    ];
    const collect = async (
      startDate: string,
      endDate: string,
      selectedShapes = shapes,
    ) =>
      Object.fromEntries(
        await Promise.all(
          selectedShapes.map(async ([name, dimensions, limit]) => {
            const rows: Json[] = [];
            let requests = 0;
            let exhausted = false;
            let first: Json = {};
            while (rows.length < limit) {
              const rowLimit = Math.min(1000, limit - rows.length);
              const result = await google(
                `https://www.googleapis.com/webmasters/v3/sites/${
                  encodeURIComponent(job.property_id)
                }/searchAnalytics/query`,
                {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    startDate,
                    endDate,
                    dimensions,
                    rowLimit,
                    startRow: rows.length,
                    type: "web",
                    dataState: "final",
                    dimensionFilterGroups: [{
                      filters: [{
                        dimension: "page",
                        operator: "includingRegex",
                        expression: `^https?://${
                          job.fqdn.replace(/\./g, "\\.")
                        }(:[0-9]+)?/`,
                      }],
                    }],
                  }),
                },
                boundedFetcher,
              );
              requests++;
              if (requests === 1) first = result;
              if (result.rows !== undefined && !Array.isArray(result.rows)) {
                throw new SyncError("google_unavailable");
              }
              const batch: Json[] = result.rows ?? [];
              if (batch.length > rowLimit) {
                throw new SyncError("google_unavailable");
              }
              rows.push(...batch);
              if (batch.length < rowLimit) {
                exhausted = true;
                break;
              }
            }
            return [name, {
              ...first,
              rows,
              collection: {
                dimensions,
                row_limit: limit,
                page_size: Math.min(1000, limit),
                requests,
                returned_rows: rows.length,
                truncated: !exhausted && dimensions.length > 0,
                coverage: "bounded_top_rows",
                anonymized_queries: dimensions.includes("query")
                  ? "excluded"
                  : "not_applicable",
                data_state: "final",
              },
            }] as const;
          }),
        ),
      );
    const start = Date.parse(`${job.start_date}T00:00:00Z`);
    const end = Date.parse(`${job.end_date}T00:00:00Z`);
    const day = 86_400_000;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(job.start_date) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(job.end_date) ||
      !Number.isFinite(start) || !Number.isFinite(end) || end < start ||
      new Date(start).toISOString().slice(0, 10) !== job.start_date ||
      new Date(end).toISOString().slice(0, 10) !== job.end_date
    ) {
      throw new SyncError("invalid_report");
    }
    const previousStart = new Date(start - (end - start + day)).toISOString()
      .slice(0, 10);
    const previousEnd = new Date(start - day).toISOString().slice(0, 10);
    const [datasets, previousDatasets] = await Promise.all([
      collect(job.start_date, job.end_date),
      collect(
        previousStart,
        previousEnd,
        shapes.filter(([name]) => ["summary", "daily", "pages"].includes(name)),
      ).catch(() => ({
        summary: { collection: { truncated: true } },
        daily: { rows: [] },
        pages: { rows: [], collection: { truncated: true } },
        unavailable: true,
        reason: "previous_period_unavailable",
      })),
    ]);
    const latestDate = (data: Json) =>
      data.daily.rows.flatMap((row: Json) =>
        typeof row.keys?.[0] === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(row.keys[0])
          ? [row.keys[0]]
          : []
      ).sort().at(-1) ?? null;
    const report: Json = {
      site_url: job.property_id,
      start_date: job.start_date,
      end_date: job.end_date,
      ...datasets,
      previous_period: {
        site_url: job.property_id,
        start_date: previousStart,
        end_date: previousEnd,
        ...previousDatasets,
        measurement: {
          version: 1,
          source: "google_search_console",
          search_type: "web",
          data_state: "final",
          date_timezone: "America/Los_Angeles",
          filters: { hostname: job.fqdn },
          provider_completeness: "not_guaranteed",
          latest_observed_date: latestDate(previousDatasets),
          observed_at: new Date().toISOString(),
          anonymized_queries: "excluded_from_query_dimensions",
        },
      },
      measurement: {
        version: 1,
        source: "google_search_console",
        search_type: "web",
        data_state: "final",
        date_timezone: "America/Los_Angeles",
        observed_at: new Date().toISOString(),
        latest_observed_date: latestDate(datasets),
        provider_completeness: "not_guaranteed",
        anonymized_queries: "excluded_from_query_dimensions",
        filters: { hostname: job.fqdn },
      },
    };
    return {
      ...report,
      analysis: analyzeSearch(report, report.previous_period),
    };
  }

  if (!/^[1-9][0-9]{0,19}$/.test(job.property_id)) {
    throw new SyncError("invalid_report");
  }
  const conversionMetrics = [
    "keyEvents",
    "sessionKeyEventRate",
    "totalRevenue",
    "sessions",
  ];
  const shapes: [string | null, string[], string, number][] =
    job.kind === "conversions"
      ? [
        [null, conversionMetrics, "keyEvents", 1],
        ["date", conversionMetrics, "date", 366],
        ["landingPagePlusQueryString", conversionMetrics, "keyEvents", 100],
        ["sessionDefaultChannelGroup", conversionMetrics, "keyEvents", 100],
        ["eventName", ["keyEvents"], "keyEvents", 100],
      ]
      : [
        [
          null,
          [
            "activeUsers",
            "sessions",
            "screenPageViews",
            "engagementRate",
            "averageSessionDuration",
          ],
          "sessions",
          1,
        ],
        ["date", ["activeUsers", "sessions", "screenPageViews"], "date", 366],
        [
          "pagePathPlusQueryString",
          ["screenPageViews", "activeUsers"],
          "screenPageViews",
          10,
        ],
        [
          "sessionDefaultChannelGroup",
          ["sessions", "activeUsers"],
          "sessions",
          10,
        ],
        ["deviceCategory", ["sessions", "activeUsers"], "sessions", 10],
      ];
  const requests = shapes.map(([dimension, metrics, order, limit]) => ({
    dateRanges: [{ startDate: job.start_date, endDate: job.end_date }],
    metrics: metrics.map((name) => ({ name })),
    dimensionFilter: {
      filter: {
        fieldName: "hostName",
        stringFilter: {
          matchType: "EXACT",
          value: job.fqdn,
          caseSensitive: false,
        },
      },
    },
    limit: String(limit),
    ...(dimension
      ? {
        dimensions: [{ name: dimension }],
        orderBys: [
          dimension === "date"
            ? { dimension: { dimensionName: order } }
            : { metric: { metricName: order }, desc: true },
        ],
      }
      : {}),
  }));
  const body = await google(
    `https://analyticsdata.googleapis.com/v1beta/properties/${job.property_id}:batchRunReports`,
    { method: "POST", headers, body: JSON.stringify({ requests }) },
    fetcher,
  );
  const reports = body.reports;
  if (!Array.isArray(reports) || reports.length !== 5) {
    throw new SyncError("google_unavailable");
  }
  const summary = reports[0];
  if (!summary || typeof summary !== "object") {
    throw new SyncError("google_unavailable");
  }
  if (
    !summary.metricHeaders && summary.kind === "analyticsData#runReport" &&
    (summary.rows === undefined ||
      Array.isArray(summary.rows) && summary.rows.length === 0) &&
    (summary.rowCount === undefined || summary.rowCount === 0)
  ) summary.metricHeaders = requests[0].metrics;
  if (reports.some((r) => !r || !Array.isArray(r.metricHeaders))) {
    throw new SyncError("google_unavailable");
  }
  const result: Json = {
    start_date: job.start_date,
    end_date: job.end_date,
    property_id: job.property_id,
    fqdn: job.fqdn,
    measurement: {
      version: 1,
      source: "google_analytics",
      observed_at: new Date().toISOString(),
      filters: { hostname: job.fqdn },
      provider_completeness: "not_guaranteed",
    },
    summary: reports[0],
    daily: reports[1],
    pages: reports[2],
    channels: reports[3],
    ...(job.kind === "conversions"
      ? { events: reports[4] }
      : { devices: reports[4] }),
  };
  if (job.kind === "conversions") {
    result.analysis = {
      version: 1,
      landing_outcomes:
        analyzeSearch(result, undefined, result).landing_outcomes,
    };
  }
  return result;
}
