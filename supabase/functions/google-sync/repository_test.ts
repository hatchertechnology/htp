import {
  fetchRepository,
  type RepositoryJob,
  runRepositorySync,
} from "./repository.ts";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const a = "a".repeat(40), b = "b".repeat(40);
const job: RepositoryJob = {
  id: "binding",
  lease: "lease",
  repository_url: "https://github.com/example/site",
  branch: null,
  head_sha: null,
  scan_ref: null,
  scan_page: 1,
};
const row = (sha = a) => ({
  sha,
  author: { login: "writer" },
  commit: {
    message: "Update service page\n\nDetails",
    author: { date: "2026-10-01T00:00:00Z", email: "not-stored@example.com" },
    committer: { date: "2026-10-02T00:00:00Z" },
  },
});
Deno.test("repository pagination pins the head and retains authored/committed dates without emails", async () => {
  const requests: string[] = [];
  const fetcher = ((url: string, options: RequestInit) => {
    requests.push(String(url));
    assert(!new Headers(options.headers).has("Authorization"));
    assert(options.redirect === "error");
    return Promise.resolve(
      Response.json(
        requests.length === 1
          ? { private: false, default_branch: "main" }
          : Array.from({ length: 100 }, () => row()),
      ),
    );
  }) as typeof fetch;
  const page = await fetchRepository(job, fetcher);
  assert(!page.done);
  assert(page.scanRef === a);
  assert(page.commits[0].committed_at === "2026-10-02T00:00:00.000Z");
  assert(!JSON.stringify(page).includes("not-stored"));
  const seen: string[] = [];
  const next = await fetchRepository(
    { ...job, scan_ref: a, scan_page: 2, head_sha: b },
    ((url: string) => {
      seen.push(String(url));
      return Promise.resolve(
        Response.json(seen.length === 1 ? { private: false } : [row(b)]),
      );
    }) as typeof fetch,
  );
  assert(new URL(seen[1]).searchParams.get("sha") === a);
  assert(new URL(seen[1]).searchParams.get("page") === "2");
  assert(next.done);
});
Deno.test("collector rejects offsite URLs and private or missing repositories", async () => {
  let hits = 0;
  for (
    const repository_url of [
      "https://evil.test/a/b",
      "https://github.com/a/..",
      "https://github.com/a/b?token=secret",
    ]
  ) {
    try {
      await fetchRepository(
        { ...job, repository_url },
        (() => {
          hits++;
          return Promise.resolve(Response.json({}));
        }) as typeof fetch,
      );
      throw new Error("accepted invalid URL");
    } catch (e) {
      assert((e as Error).message === "invalid_repository");
    }
  }
  assert(hits === 0);
  try {
    await fetchRepository(
      job,
      (() => Promise.resolve(Response.json({ private: true }))) as typeof fetch,
    );
    throw new Error("accepted private repo");
  } catch (e) {
    assert((e as Error).message === "github_repository_not_public_or_missing");
  }
});
Deno.test("worker records quota backoff and fences database completions", async () => {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  let claimed = false;
  const result = await runRepositorySync(
    (name, body) => {
      calls.push({ name, body });
      if (name === "claim_website_repository") {
        if (claimed) return Promise.resolve(null);
        claimed = true;
        return Promise.resolve(job);
      }
      return Promise.resolve(false);
    },
    (() =>
      Promise.resolve(
        new Response(null, {
          status: 429,
          headers: {
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 7200),
          },
        }),
      )) as typeof fetch,
  );
  assert(result.discarded === 1);
  const completion =
    calls.find((c) => c.name === "complete_website_repository")!.body;
  assert(completion.p_lease === job.lease);
  assert(completion.p_error === "github_rate_limited");
  assert(Number(completion.p_retry_seconds) > 7000);
});
Deno.test("empty repositories finish without inventing commits", async () => {
  let n = 0;
  const result = await fetchRepository(
    job,
    (() =>
      Promise.resolve(
        ++n === 1
          ? Response.json({ private: false, size: 0 })
          : new Response(null, { status: 409 }),
      )) as typeof fetch,
  );
  assert(result.done && result.commits.length === 0);
});
