// Disposable local runtime tests for the HTP Forms forwarder.
//
// These tests run the real Worker bundle inside Miniflare (workerd). The
// global `fetch` is routed to a synthetic in-process upstream through
// Miniflare's `outboundService`, so nothing resolves DNS, contacts Cloudflare,
// reaches the HTP API, or uses a real credential. Only cooperative normal
// visitor requests and configuration-safety cases are exercised.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://forms.test";
const FORM_ID = "00000000-0000-0000-0000-000000000001";
const ORIGIN = "https://www.example.com";
const UPSTREAM = "https://forms-upstream.invalid";
const KEY = "ab".repeat(32);
const CLIENT = "203.0.113.7";

/** @type {string} */
let script;
/** @type {typeof import("../src/index")} */
let helpers;
/** @type {Array<{url: string, method: string, headers: Record<string,string>, body: string}>} */
let forwarded;
/** @type {(request: Request) => Response | Promise<Response>} */
let upstream;

const FORM_URL = `${BASE}/public/forms/${FORM_ID}`;

before(async () => {
  const result = await build({
    entryPoints: [path.join(ROOT, "src/index.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  script = new TextDecoder().decode(result.outputFiles[0].contents);
  // Import the same bundle in Node to unit test the pure helpers directly.
  // Write under the project (gitignored) rather than the OS temp directory,
  // which may be a small or quota-limited tmpfs in CI.
  const dir = path.join(ROOT, ".wrangler-build");
  await mkdir(dir, { recursive: true });
  const bundlePath = path.join(dir, "forwarder.test-bundle.mjs");
  await writeFile(bundlePath, script);
  helpers = await import(pathToFileURL(bundlePath).href);
});

const defaultUpstream = () =>
  new Response(JSON.stringify({ ok: true, duplicate: false }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      vary: "Origin",
      "access-control-allow-origin": ORIGIN,
      // Non-contract headers that must never reach the browser.
      "set-cookie": "leak=1",
      server: "synthetic-upstream",
      "x-htp-edge-auth": "leak",
      "x-htp-client-ip": "leak",
    },
  });

/** Fresh Miniflare per test with isolated bindings and a synthetic upstream. */
async function harness(overrides = {}, upstreamFn = defaultUpstream) {
  forwarded = [];
  upstream = upstreamFn;
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "index.js", contents: script }],
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      FORMS_FORWARDER_ENABLED: "true",
      FORMS_UPSTREAM_ORIGIN: UPSTREAM,
      FORMS_EDGE_KEY: KEY,
      ...overrides,
    },
    outboundService: async (request) => {
      forwarded.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.method === "POST" ? await request.text() : "",
      });
      return upstream(request);
    },
  });
  return mf;
}

/** Sends a cooperative visitor request with the Cloudflare-derived address. */
function visitor(method, { url = FORM_URL, headers = {}, body } = {}) {
  return {
    method,
    headers: {
      "cf-connecting-ip": CLIENT,
      origin: ORIGIN,
      "content-type": "application/json",
      accept: "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  };
}

test("disabled by default is opaque and never contacts an upstream", async () => {
  const mf = await harness({ FORMS_FORWARDER_ENABLED: "false" });
  try {
    const response = await mf.dispatchFetch(
      FORM_URL,
      visitor("POST", { body: '{"name":"Ada"}' }),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "temporarily_unavailable",
    });
    assert.equal(forwarded.length, 0);
  } finally {
    await mf.dispose();
  }
});

test("preflight passes through the exact 204 CORS response", async () => {
  const preflight = () =>
    new Response(null, {
      status: 204,
      headers: {
        "cache-control": "no-store",
        vary: "Origin",
        "access-control-allow-origin": ORIGIN,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, Accept",
      },
    });
  const mf = await harness({}, preflight);
  try {
    const response = await mf.dispatchFetch(FORM_URL, visitor("OPTIONS"));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(
      response.headers.get("access-control-allow-methods"),
      "POST, OPTIONS",
    );
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].method, "OPTIONS");
    assert.equal(forwarded[0].url, `${UPSTREAM}/public/forms/${FORM_ID}`);
    assert.equal(forwarded[0].headers["x-htp-edge-auth"], KEY);
    assert.equal(forwarded[0].headers["x-htp-client-ip"], CLIENT);
  } finally {
    await mf.dispose();
  }
});

test("normal POST forwards a fresh allowlisted request and exact receipt", async () => {
  const mf = await harness();
  try {
    const payload = JSON.stringify({
      submission_id: "00000000-0000-0000-0000-000000000005",
      name: "Ada",
      email: "ada@example.com",
    });
    const response = await mf.dispatchFetch(
      `${FORM_URL}?ignored=1`,
      visitor("POST", {
        body: payload,
        // Client-supplied values that must not survive forwarding.
        headers: {
          "x-forwarded-for": "198.51.100.9",
          forwarded: "for=198.51.100.9",
          "x-htp-client-ip": "198.51.100.9",
          "x-htp-edge-auth": "attacker-supplied",
          authorization: "Bearer attacker",
          cookie: "session=attacker",
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, duplicate: false });
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("vary"), "Origin");
    // Non-contract upstream headers are dropped.
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("server"), null);
    assert.equal(response.headers.get("x-htp-edge-auth"), null);
    assert.equal(response.headers.get("x-htp-client-ip"), null);

    assert.equal(forwarded.length, 1);
    const sent = forwarded[0];
    // Query is dropped, the fixed origin is used, and the body is unchanged.
    assert.equal(sent.url, `${UPSTREAM}/public/forms/${FORM_ID}`);
    assert.equal(sent.body, payload);
    // Identity is rebuilt from the connection and the secret binding.
    assert.equal(sent.headers["x-htp-edge-auth"], KEY);
    assert.equal(sent.headers["x-htp-client-ip"], CLIENT);
    assert.equal(sent.headers.origin, ORIGIN);
    assert.equal(sent.headers["content-type"], "application/json");
    assert.equal(sent.headers.accept, "application/json");
    // No client-supplied identity, forwarding, or auth header survives.
    assert.equal(sent.headers["x-forwarded-for"], undefined);
    assert.equal(sent.headers.forwarded, undefined);
    assert.equal(sent.headers.authorization, undefined);
    assert.equal(sent.headers.cookie, undefined);
    assert.equal(sent.headers["cf-connecting-ip"], undefined);
  } finally {
    await mf.dispose();
  }
});

test("rate-limit response passes through Retry-After and CORS", async () => {
  const rateLimited = () =>
    new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        vary: "Origin",
        "access-control-allow-origin": ORIGIN,
        "access-control-expose-headers": "Retry-After",
        "retry-after": "600",
      },
    });
  const mf = await harness({}, rateLimited);
  try {
    const response = await mf.dispatchFetch(
      FORM_URL,
      visitor("POST", { body: "{}" }),
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "600");
    assert.equal(
      response.headers.get("access-control-expose-headers"),
      "Retry-After",
    );
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
  } finally {
    await mf.dispose();
  }
});

test("only the public Forms path is forwarded", async () => {
  const mf = await harness();
  try {
    for (const path of ["/", "/public/forms/not-a-uuid", "/rest/v1/rpc/accept"]) {
      const response = await mf.dispatchFetch(
        `${BASE}${path}`,
        visitor("POST", { body: "{}" }),
      );
      assert.equal(response.status, 404, path);
    }
    assert.equal(forwarded.length, 0);
  } finally {
    await mf.dispose();
  }
});

test("oversized bodies fail closed without contacting the upstream", async () => {
  const mf = await harness();
  try {
    const response = await mf.dispatchFetch(
      FORM_URL,
      visitor("POST", { body: "x".repeat(20_001) }),
    );
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "request_too_large" });
    assert.equal(forwarded.length, 0);
  } finally {
    await mf.dispose();
  }
});

test("identity, origin and key helpers reject unsafe input", async () => {
  const withIp = (value) =>
    new Request("http://forms.test", {
      headers:
        value === undefined ? {} : { "cf-connecting-ip": value },
    });
  assert.equal(helpers.clientIp(withIp("203.0.113.7")), "203.0.113.7");
  assert.equal(helpers.clientIp(withIp(undefined)), null);
  assert.equal(helpers.clientIp(withIp("")), null);
  assert.equal(helpers.clientIp(withIp("1.2.3.4, 5.6.7.8")), null);
  assert.equal(helpers.clientIp(withIp("1.2.3.4 5.6.7.8")), null);
  assert.equal(helpers.clientIp(withIp("x".repeat(46))), null);

  assert.equal(
    helpers.upstreamOrigin("https://api.example.com"),
    "https://api.example.com",
  );
  for (const value of [
    undefined,
    "",
    "not-a-url",
    "http://api.example.com",
    "https://api.example.com/path",
    "https://api.example.com?q=1",
    "https://user:pass@api.example.com",
  ]) {
    assert.equal(helpers.upstreamOrigin(value), null, String(value));
  }

  assert.equal(helpers.edgeKey("ab".repeat(32)), "ab".repeat(32));
  for (const value of [undefined, "", "AB".repeat(32), "ab".repeat(31)]) {
    assert.equal(helpers.edgeKey(value), null, String(value));
  }

  const small = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
  assert.deepEqual(await helpers.readBounded(small, 5), new Uint8Array([1, 2, 3]));
  const large = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(10));
      controller.close();
    },
  });
  assert.equal(await helpers.readBounded(large, 5), null);
});

test("invalid upstream or key configuration fails closed", async () => {
  const badUpstreams = [
    "http://forms-upstream.invalid",
    "https://forms-upstream.invalid/path",
    "https://user:pass@forms-upstream.invalid",
    "not-a-url",
  ];
  for (const value of badUpstreams) {
    const mf = await harness({ FORMS_UPSTREAM_ORIGIN: value });
    try {
      const response = await mf.dispatchFetch(
        FORM_URL,
        visitor("POST", { body: "{}" }),
      );
      assert.equal(response.status, 503, value);
    } finally {
      await mf.dispose();
    }
  }
  for (const value of ["", "AB".repeat(32), "ab".repeat(31), "zz".repeat(32)]) {
    const mf = await harness({ FORMS_EDGE_KEY: value });
    try {
      const response = await mf.dispatchFetch(
        FORM_URL,
        visitor("POST", { body: "{}" }),
      );
      assert.equal(response.status, 503, value);
    } finally {
      await mf.dispose();
    }
  }
  assert.equal(forwarded.length, 0);
});

test("upstream 5xx status and allowlisted headers pass through", async () => {
  const serviceError = () =>
    new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
      status: 500,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        vary: "Origin",
        "access-control-allow-origin": ORIGIN,
        server: "synthetic-upstream",
      },
    });
  const mf = await harness({}, serviceError);
  try {
    const response = await mf.dispatchFetch(
      FORM_URL,
      visitor("POST", { body: "{}" }),
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "temporarily_unavailable",
    });
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(response.headers.get("server"), null);
  } finally {
    await mf.dispose();
  }
});
