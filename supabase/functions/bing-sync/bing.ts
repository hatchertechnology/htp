export class BingError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export type Row = Record<string, unknown>;
export interface Job {
  id: string;
  lease: string;
  generation: string;
  owner_id: string;
  encrypted_grant: string;
  fqdn: string;
}
export interface Config {
  key: string;
  clientId: string;
  clientSecret: string;
}
export async function refreshToken(
  refresh: string,
  config: Config,
  fetcher = fetch,
) {
  const response = await fetcher(
    "https://www.bing.com/webmasters/oauth/token",
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new BingError(
      data?.error === "invalid_grant" || response.status === 401
        ? "bing_authorization_required"
        : "bing_unavailable",
    );
  }
  if (typeof data?.access_token !== "string" || !data.access_token) {
    throw new BingError("bing_unavailable");
  }
  return {
    access: data.access_token as string,
    refresh: typeof data.refresh_token === "string"
      ? data.refresh_token
      : undefined,
  };
}
export function validSite(site: unknown, host: string): site is string {
  if (typeof site !== "string" || site.length > 2048) return false;
  try {
    const u = new URL(site);
    // Bing canonicalizes www aliases to one root property. Other subdomains
    // and subdirectory properties must not masquerade as this website.
    const canonical = (name: string) => name.replace(/^www\./, "");
    return ["http:", "https:"].includes(u.protocol) &&
      canonical(u.hostname) === canonical(host) &&
      !u.username && !u.password && !u.port && !u.search && !u.hash &&
      u.pathname === "/";
  } catch {
    return false;
  }
}
const methods = [
  "GetUserSites",
  "GetRankAndTrafficStats",
  "GetQueryStats",
  "GetPageStats",
  "GetCrawlStats",
  "GetCrawlIssues",
  "GetFeeds",
] as const;
export async function bing(
  method: typeof methods[number],
  access: string,
  site: string | null,
  fetcher = fetch,
): Promise<Row[]> {
  const url = new URL(`https://www.bing.com/webmaster/api.svc/json/${method}`);
  if (site) url.searchParams.set("siteUrl", site);
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${access}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => null);
  // Bing may return an API fault with an HTTP 200 response. Never save its body.
  const fault = data?.ErrorCode ?? data?.d?.ErrorCode;
  if (!response.ok || fault != null) {
    throw new BingError(
      response.status === 401 || fault === 3
        ? "bing_authorization_required"
        : response.status === 429 || fault === 4 || fault === 5
        ? "bing_quota_exceeded"
        : response.status === 403 || [6, 13, 14].includes(fault)
        ? "bing_access_denied"
        : [7, 8, 11].includes(fault)
        ? "invalid_report"
        : "bing_unavailable",
    );
  }
  if (
    !Array.isArray(data?.d) ||
    !data.d.every((row: unknown) =>
      !!row && typeof row === "object" && !Array.isArray(row)
    )
  ) throw new BingError("bing_unavailable");
  return data.d;
}
export async function fetchReport(job: Job, access: string, fetcher = fetch) {
  const sites = (await bing("GetUserSites", access, null, fetcher))
    .filter((row) => row.IsVerified === true && validSite(row.Url, job.fqdn))
    .map((row) => ({ Url: row.Url as string, IsVerified: true }))
    .sort((a, b) =>
      Number(new URL(b.Url).hostname === job.fqdn) -
        Number(new URL(a.Url).hostname === job.fqdn) ||
      Number(b.Url.startsWith("https:")) - Number(a.Url.startsWith("https:")) ||
      a.Url.localeCompare(b.Url)
    );
  const site = sites[0]?.Url ?? null;
  if (!site) return { sites, site_url: null, sections: {} };
  const sections: Record<string, { rows: Row[] | null; error: string | null }> =
    {};
  const reports = {
    traffic: "GetRankAndTrafficStats",
    queries: "GetQueryStats",
    pages: "GetPageStats",
    crawl: "GetCrawlStats",
    issues: "GetCrawlIssues",
    sitemaps: "GetFeeds",
  } as const;
  await Promise.all(
    Object.entries(reports).map(async ([name, method]) => {
      try {
        sections[name] = {
          rows: await bing(method, access, site, fetcher),
          error: null,
        };
      } catch (cause) {
        if (
          cause instanceof BingError &&
          cause.code === "bing_authorization_required"
        ) throw cause;
        sections[name] = {
          rows: null,
          error: cause instanceof BingError ? cause.code : "bing_unavailable",
        };
      }
    }),
  );
  if (Object.values(sections).every((section) => section.error)) {
    throw new BingError(
      Object.values(sections).some((section) =>
          section.error === "bing_quota_exceeded"
        )
        ? "bing_quota_exceeded"
        : Object.values(sections).every((section) =>
            section.error === "bing_access_denied"
          )
        ? "bing_access_denied"
        : "bing_unavailable",
    );
  }
  return { sites, site_url: site, sections };
}
