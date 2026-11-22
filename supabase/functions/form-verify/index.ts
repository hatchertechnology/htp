import { limitedBody } from "../_shared/limited_body.ts";
type Dependencies = {
  challenge: (
    authorization: string,
    id: string,
  ) => Promise<{ hostname: string; challenge_hash: string } | null>;
  dns: (name: string) => Promise<unknown>;
  complete: (id: string, hash: string) => Promise<boolean>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function handle(
  request: Request,
  deps: Dependencies,
): Promise<Response> {
  const reply = (body: unknown, status: number) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "POST") {
    return reply({ error: "method_not_allowed" }, 405);
  }
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9._~-]{1,8192}$/i.test(authorization)) {
    return reply({ error: "unauthorized" }, 401);
  }
  if (Number(request.headers.get("content-length") ?? 0) > 1024) {
    return reply({ error: "invalid_request" }, 400);
  }
  let data: unknown;
  try {
    data = JSON.parse(await limitedBody(request, 1024));
  } catch {
    return reply({ error: "invalid_request" }, 400);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return reply({ error: "invalid_request" }, 400);
  }
  const { host_id, token } = data as Record<string, unknown>;
  if (
    typeof host_id !== "string" || !uuid.test(host_id) ||
    typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)
  ) return reply({ error: "invalid_request" }, 400);
  try {
    const challenge = await deps.challenge(authorization, host_id);
    if (!challenge) return reply({ error: "host_not_found" }, 404);
    const digest = await hash(token);
    if (digest !== challenge.challenge_hash) {
      return reply({ error: "verification_failed" }, 422);
    }
    const result = await deps.dns(
      `_htp-verification.${challenge.hostname}`,
    ) as { Status?: number; Answer?: { type?: number; data?: string }[] };
    const expected = `htp-verification=${token}`;
    const found = result.Status === 0 && Array.isArray(result.Answer) &&
      result.Answer.some((record) => {
        if (record.type !== 16 || typeof record.data !== "string") return false;
        try {
          return JSON.parse(record.data) === expected;
        } catch {
          return false;
        }
      });
    if (!found) return reply({ error: "verification_failed" }, 422);
    if (!await deps.complete(host_id, digest)) {
      return reply({ error: "challenge_expired_or_changed" }, 409);
    }
    return reply({ ok: true }, 200);
  } catch {
    return reply({ error: "verification_unavailable" }, 503);
  }
}
if (import.meta.main) {
  const base = Deno.env.get("SUPABASE_URL") ?? "",
    service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  async function rpc(
    name: string,
    body: unknown,
    key: string,
    authorization: string,
  ) {
    if (!base || !key) throw new Error("not_configured");
    const response = await fetch(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error("unavailable");
    return await response.json();
  }
  Deno.serve((request) =>
    handle(request, {
      challenge: (authorization, id) =>
        rpc("form_host_challenge", { p_host_id: id }, anon, authorization),
      dns: async (name) => {
        const url = new URL("https://cloudflare-dns.com/dns-query");
        url.searchParams.set("name", name);
        url.searchParams.set("type", "TXT");
        const response = await fetch(url, {
          headers: { Accept: "application/dns-json" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (
          !response.ok ||
          Number(response.headers.get("content-length") ?? 0) > 16384
        ) throw new Error("dns_unavailable");
        const text = await response.text();
        if (text.length > 16384) throw new Error("dns_unavailable");
        return JSON.parse(text);
      },
      complete: (id, challengeHash) =>
        rpc(
          "complete_form_host_verification",
          { p_host_id: id, p_hash: challengeHash },
          service,
          `Bearer ${service}`,
        ),
    })
  );
}
