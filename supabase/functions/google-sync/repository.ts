import type { Rpc } from "./worker.ts";
export interface RepositoryJob {
  id: string;
  lease: string;
  repository_url: string;
  branch: string | null;
  head_sha: string | null;
  scan_ref: string | null;
  scan_page: number;
}
class RepositoryError extends Error {
  constructor(readonly code: string, readonly retry = 3600) {
    super(code);
  }
}
const shaPattern = /^[0-9a-f]{40,64}$/;
async function json(response: Response): Promise<unknown> {
  if (!response.body) throw new RepositoryError("github_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4_000_000) {
        throw new RepositoryError("github_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(data));
}
export async function fetchRepository(job: RepositoryJob, fetcher = fetch) {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/
      .exec(job.repository_url);
  if (!match || [".", ".."].includes(match[2])) {
    throw new RepositoryError("invalid_repository");
  }
  const root = `https://api.github.com/repos/${match[1]}/${match[2]}`;
  const get = (url: string) =>
    fetcher(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "HatchTechPlatform",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  const check = (response: Response) => {
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      throw new RepositoryError(
        "github_rate_limited",
        Math.max(
          60,
          Math.min(86400, Math.ceil((reset - Date.now()) / 1000) || 3600),
        ),
      );
    }
    if (response.status === 404) {
      throw new RepositoryError("github_repository_not_public_or_missing");
    }
    if (!response.ok) throw new RepositoryError("github_unavailable");
  };
  // No credential is ever sent: private repositories cannot be imported.
  const metadata = await get(root);
  check(metadata);
  const repo = await json(metadata) as {
    private?: boolean;
    default_branch?: string;
    size?: number;
  };
  if (repo.private !== false) {
    throw new RepositoryError("github_repository_not_public_or_missing");
  }
  const url = new URL(`${root}/commits`);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(job.scan_page));
  url.searchParams.set(
    "sha",
    job.scan_ref ?? job.branch ?? repo.default_branch ?? "main",
  );
  const response = await get(url.toString());
  if (response.status === 409 && repo.size === 0) {
    return { commits: [], scanRef: job.scan_ref, done: true };
  }
  check(response);
  const rows = await json(response);
  if (!Array.isArray(rows) || rows.length > 100) {
    throw new RepositoryError("github_invalid_response");
  }
  const commits = rows.map((row) => {
    if (
      !shaPattern.test(row?.sha) || typeof row?.commit?.message !== "string" ||
      !Number.isFinite(Date.parse(row?.commit?.committer?.date))
    ) throw new RepositoryError("github_invalid_response");
    const authored = row.commit.author?.date;
    return {
      sha: row.sha,
      message: row.commit.message.slice(0, 20000),
      author: String(row.author?.login ?? row.commit.author?.name ?? "").slice(
        0,
        256,
      ),
      authored_at: Number.isFinite(Date.parse(authored))
        ? new Date(authored).toISOString()
        : null,
      committed_at: new Date(row.commit.committer.date).toISOString(),
    };
  });
  // Pin pagination to the first observed SHA so new pushes cannot shift pages.
  const scanRef = job.scan_ref ?? commits[0]?.sha ?? null;
  return {
    commits,
    scanRef,
    done: commits.length < 100 || commits.some((c) => c.sha === job.head_sha),
  };
}
export async function runRepositorySync(
  rpc: Rpc,
  fetcher = fetch,
  now = Date.now,
) {
  let completed = 0, failed = 0, discarded = 0;
  const deadline = now() + 25_000;
  for (let i = 0; i < 2 && now() < deadline; i++) {
    const job = await rpc("claim_website_repository", {}) as
      | RepositoryJob
      | null;
    if (!job) break;
    let result;
    try {
      const page = await fetchRepository(job, fetcher);
      result = {
        p_commits: page.commits,
        p_scan_ref: page.scanRef,
        p_done: page.done,
        p_error: null,
      };
    } catch (error) {
      result = {
        p_commits: [],
        p_scan_ref: job.scan_ref,
        p_done: false,
        p_error: error instanceof RepositoryError
          ? error.code
          : "github_unavailable",
        p_retry_seconds: error instanceof RepositoryError ? error.retry : 3600,
      };
    }
    const saved = await rpc("complete_website_repository", {
      p_id: job.id,
      p_lease: job.lease,
      ...result,
    });
    if (!saved) discarded++;
    else if (result.p_error) failed++;
    else completed++;
  }
  return { completed, failed, discarded };
}
