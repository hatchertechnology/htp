type Rpc = (name: string, params: Record<string, unknown>) => Promise<unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limit = 20_000;

function browserOrigin(
  request: Request,
): { origin: string; host: string } | null {
  const origin = request.headers.get("origin");
  const raw = origin ?? request.headers.get("referer");
  if (!raw || raw === "null") return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" || url.username || url.password || url.port ||
      !url.hostname ||
      (origin !== null && (url.pathname !== "/" || url.search || url.hash))
    ) return null;
    return { origin: url.origin, host: url.hostname };
  } catch {
    return null;
  }
}

export async function limitedBody(
  request: Request,
  maxBytes = limit,
): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    throw new Error("too_large");
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError("invalid_utf8");
  }
}

export async function handle(request: Request, rpc: Rpc): Promise<Response> {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  const respond = (body: unknown, status: number) =>
    Response.json(body, { status, headers });
  const id = new URL(request.url).searchParams.get("form") ?? "";
  if (!uuid.test(id)) return respond({ error: "form_unavailable" }, 404);
  const source = browserOrigin(request);
  try {
    const admission = await rpc("charge_form_ingress", { p_form_id: id });
    if (admission === "unavailable") {
      return respond({ error: "form_unavailable" }, 404);
    }
    if (admission !== "ok" && admission !== "rate_limited") {
      return respond({ error: "temporarily_unavailable" }, 503);
    }
    if (!source) return respond({ error: "origin_required" }, 403);
    if (
      !await rpc("website_form_origin_allowed", {
        p_form_id: id,
        p_host: source.host,
      })
    ) return respond({ error: "form_unavailable" }, 404);
    headers.set("Access-Control-Allow-Origin", source.origin);
    if (admission === "rate_limited") {
      headers.set("Retry-After", "600");
      headers.set("Access-Control-Expose-Headers", "Retry-After");
      return respond({ error: "rate_limited" }, 429);
    }
    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") {
      return respond({ error: "method_not_allowed" }, 405);
    }
    const body = await limitedBody(request);
    const type = request.headers.get("content-type")?.split(";", 1)[0]
      ?.toLowerCase();
    let input: Record<string, unknown>;
    if (type === "application/json") {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return respond({ error: "invalid_request" }, 400);
      }
      input = parsed as Record<string, unknown>;
    } else if (type === "application/x-www-form-urlencoded") {
      const params = new URLSearchParams(body);
      input = {};
      for (const [key, value] of params) {
        if (Object.hasOwn(input, key)) {
          return respond({ error: "invalid_request" }, 400);
        }
        input[key] = value;
      }
    } else return respond({ error: "unsupported_content_type" }, 415);
    const submission = input.submission_id ??
      (type === "application/x-www-form-urlencoded"
        ? crypto.randomUUID()
        : undefined);
    if (typeof submission !== "string" || !uuid.test(submission)) {
      return respond({ error: "invalid_submission_id" }, 400);
    }
    if (input.website !== undefined && input.website !== "") {
      return respond({ error: "spam_rejected" }, 422);
    }
    delete input.submission_id;
    delete input.website;
    const result = await rpc("accept_website_form", {
      p_form_id: id,
      p_submission_id: submission,
      p_host: source.host,
      p_values: input,
    }) as Record<string, unknown>;
    const codes: Record<string, number> = {
      form_unavailable: 404,
      invalid_request: 400,
      validation_failed: 422,
      idempotency_conflict: 409,
      rate_limited: 429,
    };
    return respond(
      result,
      result.ok === true ? 200 : (codes[String(result.error)] ?? 503),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "too_large") {
      return respond({ error: "request_too_large" }, 413);
    }
    if (error instanceof SyntaxError) {
      return respond({ error: "invalid_request" }, 400);
    }
    return respond({ error: "temporarily_unavailable" }, 503);
  }
}

if (import.meta.main) {
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  Deno.serve((request) =>
    handle(request, async (name, params) => {
      if (!base || !key) throw new Error("not_configured");
      const response = await fetch(`${base}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("database_unavailable");
      return await response.json();
    })
  );
}
