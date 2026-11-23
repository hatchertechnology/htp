import { handle, lookupTxt } from "./index.ts";
function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
}
const id = "00000000-0000-0000-0000-000000000001", token = "a".repeat(64);
const digest = Array.from(
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ),
  (b) => b.toString(16).padStart(2, "0"),
).join("");
const request = () =>
  new Request("https://htp.test/verify", {
    method: "POST",
    headers: {
      authorization: "Bearer valid",
      "content-type": "application/json",
    },
    body: JSON.stringify({ host_id: id, token }),
  });
Deno.test("requires matching TXT and current challenge before marking verified", async () => {
  let completed = 0;
  const deps = {
    challenge: () =>
      Promise.resolve({ hostname: "www.example.com", challenge_hash: digest }),
    dns: (name: string) => {
      equal(name, "_htp-verification.www.example.com");
      return Promise.resolve({
        Status: 0,
        Answer: [{
          type: 16,
          data: JSON.stringify(`htp-verification=${token}`),
        }],
      });
    },
    complete: () => {
      completed++;
      return Promise.resolve(true);
    },
  };
  equal((await handle(request(), deps)).status, 200);
  equal(completed, 1);
  deps.dns = () =>
    Promise.resolve({ Status: 0, Answer: [{ type: 16, data: '"wrong"' }] });
  equal((await handle(request(), deps)).status, 422);
  equal(completed, 1);
  deps.challenge = () =>
    Promise.resolve({
      hostname: "www.example.com",
      challenge_hash: "0".repeat(64),
    });
  equal((await handle(request(), deps)).status, 422);
  equal(completed, 1);
});
Deno.test("denies a host unavailable to the authenticated user", async () => {
  let completed = 0;
  const response = await handle(request(), {
    challenge: () => Promise.resolve(null),
    dns: () => Promise.resolve({}),
    complete: () => {
      completed++;
      return Promise.resolve(true);
    },
  });
  equal(response.status, 404);
  equal(completed, 0);
});

Deno.test("DNS response limit counts streamed UTF-8 bytes before completion", async () => {
  const limit = 16384;
  // Each é occupies two bytes. The quotes supply the remaining two.
  const value = "é".repeat((limit - 2) / 2);
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  equal(bytes.length, limit);
  equal(
    await lookupTxt("example.test", () => Promise.resolve(new Response(bytes))),
    value,
  );

  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls > 2) controller.close();
      else controller.enqueue(pulls === 1 ? bytes : Uint8Array.of(32));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  let completions = 0;
  const result = await handle(request(), {
    challenge: () =>
      Promise.resolve({ hostname: "example.test", challenge_hash: digest }),
    dns: (name) => lookupTxt(name, () => Promise.resolve(new Response(body))),
    complete: () => {
      completions++;
      return Promise.resolve(true);
    },
  });
  equal(result.status, 503);
  equal(completions, 0);
  equal(cancelled, true);
  equal(pulls, 2);
});

Deno.test("CORS is scoped and does not bypass authentication", async () => {
  let calls = 0;
  const deps = {
    challenge: () => {
      calls++;
      return Promise.resolve(null);
    },
    dns: () => Promise.resolve({}),
    complete: () => Promise.resolve(false),
  };
  const origin = "https://htp.hatchtech.dev";
  const preflight = await handle(
    new Request("https://example.test", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,apikey,x-client-info,content-type",
      },
    }),
    deps,
  );
  equal(preflight.status, 204);
  equal(preflight.headers.get("access-control-allow-origin"), origin);
  const unauth = await handle(
    new Request("https://example.test", {
      method: "POST",
      headers: { Origin: origin },
    }),
    deps,
  );
  equal(unauth.status, 401);
  equal(unauth.headers.get("access-control-allow-origin"), origin);
  const foreign = await handle(
    new Request("https://example.test", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.test" },
    }),
    deps,
  );
  equal(foreign.status, 403);
  equal(foreign.headers.get("access-control-allow-origin"), null);
  equal(calls, 0);
});
