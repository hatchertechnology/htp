import { google, type Job, type Json, SyncError } from "./google.ts";

export interface InsightKeys {
  pagespeedKey?: string;
  cruxKey?: string;
}
const profileFields =
  "name,title,storeCode,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,specialHours,serviceArea,openInfo,profile,moreHours,serviceItems,labels,latlng";

// Normalize unordered API arrays to prevent changes caused only by response order.
export function canonical(value: unknown, field = ""): unknown {
  if (Array.isArray(value)) {
    const values = value.map((item) => canonical(item));
    // Address lines and other ordered arrays retain their meaning.
    return [
        "additionalPhones",
        "additionalCategories",
        "periods",
        "specialHourPeriods",
        "moreHours",
        "serviceItems",
        "labels",
        "attributes",
        "values",
        "urlValues",
      ].includes(field)
      ? values.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      )
      : values;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
        [key, item],
      ) => [key, canonical(item, key)]),
    );
  }
  return value;
}

async function pages(
  url: URL,
  field: string,
  headers: Record<string, string>,
  fetcher: typeof fetch,
): Promise<Json[]> {
  const rows: Json[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const data = await google(url.href, { headers }, fetcher);
    rows.push(...(data[field] ?? []));
    if (!data.nextPageToken) return rows;
    if (seen.has(data.nextPageToken)) throw new SyncError("google_unavailable");
    seen.add(data.nextPageToken);
    url.searchParams.set("pageToken", data.nextPageToken);
  }
  // Do not save a truncated discovery response as a complete list.
  throw new SyncError("google_quota_exceeded");
}
export async function fetchInsight(
  job: Job,
  access: string,
  keys: InsightKeys,
  fetcher = fetch,
): Promise<Json> {
  // Bound the entire multi-page discovery job, not just individual HTTP calls.
  const providerFetch = fetcher;
  const deadline = AbortSignal.timeout(55_000);
  fetcher = ((url, options) =>
    providerFetch(url, {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([deadline, options.signal])
        : deadline,
    })) as typeof fetch;
  const headers = {
    Authorization: `Bearer ${access}`,
    "Content-Type": "application/json",
  };
  if (job.kind === "pagespeed") {
    if (!keys.pagespeedKey) throw new SyncError("integration_not_configured");
    if (!["mobile", "desktop"].includes(job.property_id)) {
      throw new SyncError("invalid_report");
    }
    const url = new URL(
      "https://www.googleapis.com/pagespeedonline/v5/runPagespeed",
    );
    url.searchParams.set("url", `https://${job.fqdn}/`);
    url.searchParams.set("key", keys.pagespeedKey);
    url.searchParams.set("strategy", job.property_id);
    for (
      const category of [
        "performance",
        "accessibility",
        "best-practices",
        "seo",
      ]
    ) url.searchParams.append("category", category);
    const data = await google(url.href, {}, fetcher, 55_000);
    const lighthouse = data.lighthouseResult;
    if (
      !lighthouse || lighthouse.runtimeError ||
      !lighthouse.categories?.performance
    ) throw new SyncError("google_unavailable");
    // Keep audit diagnostics and provenance, omit large embedded screenshots.
    const audits = Object.fromEntries(
      Object.entries(lighthouse.audits ?? {}).filter(([id]) =>
        !["screenshot-thumbnails", "final-screenshot"].includes(id)
      ),
    );
    return {
      url: `https://${job.fqdn}/`,
      strategy: job.property_id,
      analysisUTCTimestamp: data.analysisUTCTimestamp,
      lighthouseResult: {
        ...lighthouse,
        audits,
        fullPageScreenshot: undefined,
      },
    };
  }
  if (job.kind === "crux") {
    if (!keys.cruxKey) throw new SyncError("integration_not_configured");
    if (!["PHONE", "DESKTOP"].includes(job.property_id)) {
      throw new SyncError("invalid_report");
    }
    const data = await google(
      `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${
        encodeURIComponent(keys.cruxKey)
      }`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: `https://${job.fqdn}`,
          formFactor: job.property_id,
          metrics: [
            "largest_contentful_paint",
            "interaction_to_next_paint",
            "cumulative_layout_shift",
          ],
        }),
      },
      fetcher,
      20_000,
      true,
    );
    if (
      data.error?.status !== "NOT_FOUND" &&
      (!data.record?.collectionPeriod || !data.record?.metrics)
    ) throw new SyncError("google_unavailable");
    return data.error?.status === "NOT_FOUND"
      ? {
        available: false,
        reason: "insufficient_data",
        origin: `https://${job.fqdn}`,
        formFactor: job.property_id,
      }
      : { available: true, ...data };
  }
  if (job.kind === "business_locations") {
    const accounts = await pages(
      new URL(
        "https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20",
      ),
      "accounts",
      headers,
      fetcher,
    );
    const locations = new Map<string, Json>();
    for (const account of accounts) {
      if (!/^accounts\/[0-9]+$/.test(account.name)) continue;
      const url = new URL(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations`,
      );
      url.searchParams.set(
        "readMask",
        "name,title,storefrontAddress,websiteUri",
      );
      url.searchParams.set("pageSize", "100");
      for (const location of await pages(url, "locations", headers, fetcher)) {
        if (/^locations\/[0-9]+$/.test(location.name)) {
          locations.set(location.name, location);
        }
      }
    }
    return { locations: [...locations.values()] };
  }
  if (!/^locations\/[0-9]+$/.test(job.property_id)) {
    throw new SyncError("invalid_report");
  }
  if (job.kind === "business_profile") {
    const base =
      `https://mybusinessbusinessinformation.googleapis.com/v1/${job.property_id}`;
    const [location, attributes] = await Promise.all([
      google(`${base}?readMask=${encodeURIComponent(profileFields)}`, {
        headers,
      }, fetcher),
      google(`${base}/attributes`, { headers }, fetcher),
    ]);
    if (
      location.name !== job.property_id || typeof location.title !== "string" ||
      (attributes.attributes !== undefined &&
        !Array.isArray(attributes.attributes))
    ) throw new SyncError("google_unavailable");
    return {
      location: canonical({
        ...location,
        attributes: attributes.attributes ?? [],
      }),
    };
  }
  if (job.kind === "business_performance") {
    const url = new URL(
      `https://businessprofileperformance.googleapis.com/v1/${job.property_id}:fetchMultiDailyMetricsTimeSeries`,
    );
    for (
      const metric of [
        "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
        "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
        "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
        "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
        "WEBSITE_CLICKS",
        "CALL_CLICKS",
        "BUSINESS_DIRECTION_REQUESTS",
      ]
    ) url.searchParams.append("dailyMetrics", metric);
    for (
      const [label, date] of [["startDate", job.start_date], [
        "endDate",
        job.end_date,
      ]]
    ) {
      const [year, month, day] = date.split("-").map(Number);
      url.searchParams.set(`dailyRange.${label}.year`, String(year));
      url.searchParams.set(`dailyRange.${label}.month`, String(month));
      url.searchParams.set(`dailyRange.${label}.day`, String(day));
    }
    return {
      location: job.property_id,
      start_date: job.start_date,
      end_date: job.end_date,
      ...await google(url.href, { headers }, fetcher),
    };
  }
  throw new SyncError("invalid_report");
}
