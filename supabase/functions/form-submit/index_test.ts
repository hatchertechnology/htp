import { handle } from "./index.ts";
function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
const id = "00000000-0000-0000-0000-000000000001";
const submission = "00000000-0000-0000-0000-000000000002";
const endpoint = `https://api.example.test/form-submit?form=${id}`;
Deno.test("verified browser origin and accepted storage produce success", async () => {
  const calls: string[] = [];
  const response = await handle(
    new Request(endpoint, {
      method: "POST",
      headers: {
        origin: "https://www.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ submission_id: submission, name: "Ada" }),
    }),
    (name, args) => {
      calls.push(name);
      if (name === "charge_form_ingress") return Promise.resolve("ok");
      if (name === "website_form_origin_allowed") {
        return Promise.resolve(
          args.p_host === "www.example.com",
        );
      }
      return Promise.resolve({ ok: true, duplicate: false });
    },
  );
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("access-control-allow-origin"),
    "https://www.example.com",
  );
  assertEquals(await response.json(), { ok: true, duplicate: false });
  assertEquals(calls, [
    "charge_form_ingress",
    "website_form_origin_allowed",
    "accept_website_form",
  ]);
});
Deno.test("missing, foreign and insecure origins never reach acceptance", async () => {
  let calls = 0;
  const rpc = (name: string, args: Record<string, unknown>) => {
    if (name === "charge_form_ingress") return Promise.resolve("ok");
    calls++;
    return Promise.resolve(args.p_host === "www.example.com");
  };
  for (
    const origin of [
      undefined,
      "http://www.example.com",
      "https://example.com",
      "null",
    ]
  ) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (origin) headers.origin = origin;
    const response = await handle(
      new Request(endpoint, { method: "POST", headers, body: "{}" }),
      rpc,
    );
    assertEquals(response.status >= 400, true);
  }
  assertEquals(calls, 1);
});
Deno.test("invalid submissions and honeypot are rejected without storage", async () => {
  let accepts = 0;
  const rpc = (name: string) => {
    if (name === "accept_website_form") accepts++;
    return Promise.resolve(name === "charge_form_ingress" ? "ok" : true);
  };
  for (
    const body of [
      `submission_id=${submission}&website=spam`,
      `submission_id=${submission}&name=a&name=b`,
      "submission_id=bad",
    ]
  ) {
    const response = await handle(
      new Request(endpoint, {
        method: "POST",
        headers: {
          origin: "https://www.example.com",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      }),
      rpc,
    );
    assertEquals(response.status >= 400, true);
  }
  assertEquals(accepts, 0);
});
Deno.test("referer fallback and preflight are bounded to allowed origins", async () => {
  const rpc = (name: string, args: Record<string, unknown>) =>
    Promise.resolve(
      name === "charge_form_ingress" ? "ok" : args.p_host === "www.example.com",
    );
  const preflight = await handle(
    new Request(endpoint, {
      method: "OPTIONS",
      headers: { origin: "https://www.example.com" },
    }),
    rpc,
  );
  assertEquals(preflight.status, 204);
  const missing = await handle(
    new Request(endpoint, {
      method: "POST",
      headers: {
        referer: "https://www.example.com/quote",
        "content-type": "text/plain",
      },
      body: "x",
    }),
    rpc,
  );
  assertEquals(missing.status, 415);
});

Deno.test("ordinary HTML form may omit an id; server generates one", async () => {
  let id: unknown;
  const rpc = (name: string, args: Record<string, unknown>) => {
    if (name === "accept_website_form") {
      id = args.p_submission_id;
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve(name === "charge_form_ingress" ? "ok" : true);
  };
  const response = await handle(
    new Request(endpoint, {
      method: "POST",
      headers: {
        referer: "https://www.example.com/quote",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "name=Ada",
    }),
    rpc,
  );
  assertEquals(response.status, 200);
  assertEquals(typeof id, "string");
});
Deno.test("storage outage never returns an accepted response", async () => {
  const response = await handle(
    new Request(endpoint, {
      method: "POST",
      headers: {
        origin: "https://www.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ submission_id: submission, name: "Ada" }),
    }),
    (name) =>
      name === "charge_form_ingress"
        ? Promise.resolve("ok")
        : name === "website_form_origin_allowed"
        ? Promise.resolve(true)
        : Promise.reject(new TypeError("network failure")),
  );
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { error: "temporarily_unavailable" });
});

Deno.test("form-wide ingress limits include preflights and retain CORS for the allowed host", async () => {
  const calls: string[] = [];
  const response = await handle(
    new Request(endpoint, {
      method: "OPTIONS",
      headers: { origin: "https://www.example.com" },
    }),
    (name) => {
      calls.push(name);
      return Promise.resolve(
        name === "charge_form_ingress" ? "rate_limited" : true,
      );
    },
  );
  assertEquals(response.status, 429);
  assertEquals(
    response.headers.get("access-control-allow-origin"),
    "https://www.example.com",
  );
  assertEquals(response.headers.get("retry-after"), "600");
  assertEquals(calls, ["charge_form_ingress", "website_form_origin_allowed"]);
});
