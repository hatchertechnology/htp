/**
 * HTP Forms forwarder.
 *
 * A default-disabled Cloudflare Worker that forwards browser form requests to
 * one fixed HTTPS HTP forms API origin. It exists because the HTP API cannot
 * derive the visitor address from the connection it sees: a Cloudflare Worker
 * subrequest to a non-Cloudflare origin is made from Cloudflare's network, so
 * the Worker controls every client-IP header on that subrequest. The receiving
 * API therefore authenticates the Worker with a shared secret and accepts the
 * visitor address only from the authenticated request.
 *
 * Trust boundary and documented limitations (see docs/forms/forwarder.md):
 *  - The Worker reads the visitor address only from the Cloudflare-set
 *    `CF-Connecting-IP` header. It never reads `X-Forwarded-For`, `Forwarded`,
 *    `X-Real-IP`, or any other client-supplied identity header.
 *  - The receiving API must not trust connection-derived identity either. It
 *    verifies `X-HTP-Edge-Auth` against a server-side key and only then reads
 *    `X-HTP-Client-IP`. A direct call to the API without the key fails closed.
 *  - `CF-Connecting-IP` is only authoritative while Cloudflare is the direct
 *    edge for the Worker hostname. A stacked proxy/CDN in front of Cloudflare,
 *    a Worker service binding, or local `wrangler dev` can change or omit it.
 *
 * This Worker forwards normal visitor requests only. It performs no attack
 * probing, retries, redirects, deduplication, or receipt invention.
 */

const MAX_BODY_BYTES = 20_000;
const FORWARD_TIMEOUT_MS = 24_000;

/** Only the public Forms route with a canonical hyphenated UUID. */
const FORM_PATH =
  /^\/public\/forms\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Public contract headers copied from the browser. Nothing else. */
const FORWARD_REQUEST_HEADERS = [
  "origin",
  "referer",
  "content-type",
  "accept",
] as const;

/** Response headers the API contract needs. Everything else is dropped. */
const FORWARD_RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "vary",
  "retry-after",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
]);

/** Opaque forwarder error. Never reflects Origin and never invents a receipt. */
function opaque(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/**
 * Returns a fixed HTTPS origin (scheme, host, optional port) or null. Rejects
 * credentials, paths, query strings, fragments and any non-HTTPS scheme so a
 * misconfiguration cannot turn the Worker into an open proxy.
 */
export function upstreamOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return null;
  }
  if (url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== "/") return null;
  return url.origin;
}

/** Exactly 64 lowercase hex characters, matching the API edge key format. */
export function edgeKey(raw: string | undefined): string | null {
  if (raw === undefined || !/^[0-9a-f]{64}$/.test(raw)) return null;
  return raw;
}

/**
 * Reads the Cloudflare-set visitor address. Rejects missing, comma-joined or
 * whitespace-bearing values so header injection cannot smuggle extra data.
 * The API still parses and rejects a non-IP value.
 */
export function clientIp(request: Request): string | null {
  const value = request.headers.get("cf-connecting-ip");
  if (value === null) return null;
  if (value.length === 0 || value.length > 45) return null;
  if (/[\s,]/.test(value)) return null;
  return value;
}

/**
 * Reads at most `limit` bytes from a request body. Returns null when the body
 * exceeds the limit; the caller cancels the stream in that case.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.FORMS_FORWARDER_ENABLED !== "true") {
      return opaque(503, "temporarily_unavailable");
    }
    if (request.method !== "POST" && request.method !== "OPTIONS") {
      return opaque(405, "method_not_allowed");
    }
    const url = new URL(request.url);
    if (!FORM_PATH.test(url.pathname)) {
      return opaque(404, "form_unavailable");
    }
    const origin = upstreamOrigin(env.FORMS_UPSTREAM_ORIGIN);
    const key = edgeKey(env.FORMS_EDGE_KEY);
    const ip = clientIp(request);
    if (origin === null || key === null || ip === null) {
      return opaque(503, "temporarily_unavailable");
    }

    const headers = new Headers();
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("x-htp-client-ip", ip);
    headers.set("x-htp-edge-auth", key);

    let body: Uint8Array | undefined;
    if (request.method === "POST") {
      const contentLength = request.headers.get("content-length");
      if (contentLength !== null) {
        const declared = Number(contentLength);
        if (!Number.isInteger(declared) || declared > MAX_BODY_BYTES) {
          return opaque(413, "request_too_large");
        }
      }
      const bounded = await readBounded(request.body, MAX_BODY_BYTES);
      if (bounded === null) {
        return opaque(413, "request_too_large");
      }
      body = bounded;
    }

    let upstream: Response;
    try {
      upstream = await fetch(origin + url.pathname, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
    } catch {
      return opaque(503, "temporarily_unavailable");
    }

    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
      if (FORWARD_RESPONSE_HEADERS.has(name.toLowerCase())) {
        responseHeaders.set(name, value);
      }
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  },
} satisfies ExportedHandler<Env>;
