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
  kind: "analytics" | "search" | "properties";
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
async function google(
  url: string,
  options: RequestInit,
  fetcher: typeof fetch,
): Promise<Json> {
  const response = await fetcher(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const value = await response.json();
  if (!response.ok) {
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
    const shapes: [string[], number][] = [[[], 1], [["date"], 366], [
      ["query"],
      10,
    ], [["page"], 10]];
    const reports = await Promise.all(
      shapes.map(([dimensions, rowLimit]) =>
        google(
          `https://www.googleapis.com/webmasters/v3/sites/${
            encodeURIComponent(job.property_id)
          }/searchAnalytics/query`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              startDate: job.start_date,
              endDate: job.end_date,
              dimensions,
              rowLimit,
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
          fetcher,
        )
      ),
    );
    return {
      site_url: job.property_id,
      start_date: job.start_date,
      end_date: job.end_date,
      summary: reports[0],
      daily: reports[1],
      queries: reports[2],
      pages: reports[3],
    };
  }
  if (!/^[1-9][0-9]{0,19}$/.test(job.property_id)) {
    throw new SyncError("invalid_report");
  }
  const shapes: [string | null, string[], string, number][] = [
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
    ["sessionDefaultChannelGroup", ["sessions", "activeUsers"], "sessions", 10],
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
  return {
    summary: reports[0],
    daily: reports[1],
    pages: reports[2],
    channels: reports[3],
    devices: reports[4],
  };
}
