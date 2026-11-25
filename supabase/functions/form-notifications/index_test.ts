import { admit, handle, run, validVerifyUrl } from "./index.ts";
function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
}
const job = {
  id: "job",
  lease: "lease",
  kind: "response" as const,
  recipient_id: "recipient",
  email: "owner@example.com",
  token: null,
  form_name: "Quote",
  reply_to: "customer@example.com",
};
Deno.test("sends from configured sender with visitor reply-to and records outcome", async () => {
  let message: Record<string, string> = {}, finished = "";
  const result = await run({
    claim: () => Promise.resolve(job),
    finish: (_id, _lease, state) => {
      finished = state;
      return Promise.resolve(true);
    },
    send: (value) => {
      message = value;
      return Promise.resolve("sent");
    },
    sender: "HTP <sender@example.com>",
    verifyUrl: "https://htp.test/forms/confirm",
  });
  equal(result, { processed: true, state: "sent" });
  equal(message.ReplyTo, "customer@example.com");
  equal(message.TrackLinks, "None");
  equal(message.HtmlBody, undefined);
  equal(finished, "sent");
});
Deno.test("ambiguous provider failures remain uncertain", async () => {
  let finished = "";
  await run({
    claim: () => Promise.resolve(job),
    finish: (_id, _lease, state) => {
      finished = state;
      return Promise.resolve(true);
    },
    send: () => Promise.reject(new Error("timeout")),
    sender: "sender@example.com",
    verifyUrl: "https://htp.test/forms/confirm",
  });
  equal(finished, "uncertain");
});
Deno.test("scheduler secret is required", async () => {
  let claimed = false;
  const response = await handle(
    new Request("https://test/", { method: "POST" }),
    "secret",
    {
      claim: () => {
        claimed = true;
        return Promise.resolve(null);
      },
      finish: () => Promise.resolve(true),
      send: () => Promise.resolve("sent"),
      sender: "a",
      verifyUrl: "https://test/",
    },
  );
  equal(response.status, 401);
  equal(claimed, false);
});

Deno.test("invalid visitor reply-to is omitted", async () => {
  let message: Record<string, string> = {};
  await run({
    claim: () =>
      Promise.resolve({ ...job, reply_to: "bad..address@example.com" }),
    finish: () => Promise.resolve(true),
    send: (value) => {
      message = value;
      return Promise.resolve("sent");
    },
    sender: "sender@example.com",
    verifyUrl: "https://htp.test/forms/confirm",
  });
  equal(message.ReplyTo, undefined);
});

Deno.test("unconfirmed completion is unavailable even after provider acceptance", async () => {
  let sent = 0;
  const response = await handle(
    new Request("https://test/", {
      method: "POST",
      headers: { "x-htp-sync-secret": "fixture-secret" },
    }),
    "fixture-secret",
    {
      claim: () => Promise.resolve(job),
      finish: () => Promise.resolve(false),
      send: () => {
        sent++;
        return Promise.resolve("sent");
      },
      sender: "sender@example.com",
      verifyUrl: "https://test/",
    },
  );
  equal(response.status, 503);
  equal(await response.json(), { error: "delivery_unavailable" });
  equal(sent, 1);
});
Deno.test("verification contains a confirmation fragment and empty queue sends nothing", async () => {
  let captured: Record<string, string> = {};
  const verification = {
    ...job,
    kind: "verification" as const,
    token: "a".repeat(64),
    reply_to: null,
  };
  const deps = {
    claim: () => Promise.resolve(verification),
    finish: () => Promise.resolve(true),
    send: (message: Record<string, string>) => {
      captured = message;
      return Promise.resolve("sent" as const);
    },
    sender: "sender@example.com",
    verifyUrl: "https://htp.test/forms/confirm",
  };
  equal(await run(deps), { processed: true, state: "sent" });
  equal(
    captured.TextBody.includes(
      `https://htp.test/forms/confirm#recipient:${verification.token}`,
    ),
    true,
  );
  equal(captured.TrackLinks, "None");
  equal(captured.HtmlBody, undefined);
  let sends = 0;
  equal(
    await run({
      ...deps,
      claim: () => Promise.resolve(null),
      send: () => {
        sends++;
        return Promise.resolve("sent" as const);
      },
    }),
    { processed: false },
  );
  equal(sends, 0);
});
Deno.test("known rejection is recorded as failed for owner retry", async () => {
  let saved = "";
  const result = await run({
    claim: () => Promise.resolve(job),
    finish: (_id, _lease, state) => {
      saved = state;
      return Promise.resolve(true);
    },
    send: () => Promise.resolve("failed"),
    sender: "sender@example.com",
    verifyUrl: "https://test/",
  });
  equal(result, { processed: true, state: "failed" });
  equal(saved, "failed");
});

Deno.test("worker delivery requires explicit independent enablement before admission", async () => {
  let calls = 0;
  const deps = {
    claim: () => {
      calls++;
      return Promise.resolve(null);
    },
    finish: () => {
      calls++;
      return Promise.resolve(true);
    },
    send: () => {
      calls++;
      return Promise.resolve("sent" as const);
    },
    sender: "sender@example.com",
    verifyUrl: "https://htp.test/forms/confirm",
  };
  const config = {
    enabled: "true",
    base: "https://database.test",
    service: "fixture",
    postmark: "fixture",
    secret: "fixture-secret",
  };
  const request = () =>
    new Request("https://worker.test", {
      method: "POST",
      headers: { "x-htp-sync-secret": "fixture-secret" },
    });
  for (const enabled of ["", "false", "TRUE", "1", " true "]) {
    const response = await admit(request(), { ...config, enabled }, deps);
    equal(response.status, 503);
    equal(await response.json(), { error: "delivery_disabled" });
  }
  equal(calls, 0);
  for (
    const verifyUrl of [
      "https://htp.test/other",
      "https://htp.test/forms/confirm#private",
    ]
  ) {
    const response = await admit(request(), config, { ...deps, verifyUrl });
    equal(response.status, 503);
    equal(await response.json(), { error: "delivery_not_configured" });
  }
  equal(calls, 0);
  equal(
    (await admit(
      new Request("https://worker.test", { method: "POST" }),
      config,
      deps,
    )).status,
    401,
  );
  equal(
    (await admit(new Request("https://worker.test"), config, deps)).status,
    405,
  );
  equal(calls, 0);
  const response = await admit(request(), config, deps);
  equal(response.status, 200);
  equal(await response.json(), { processed: false });
  equal(calls, 1);
});

Deno.test("confirmation target is an exact HTTPS route without credentials, query or fragment", () => {
  equal(validVerifyUrl("https://htp.test/forms/confirm"), true);
  for (
    const value of [
      "",
      "https://",
      "http://htp.test/forms/confirm",
      "https://user:pass@htp.test/forms/confirm",
      "https://htp.test/forms/confirm/",
      "https://htp.test/forms/confirm?x=1",
      "https://htp.test/forms/confirm?",
      "https://htp.test/forms/confirm#token",
      "https://htp.test/forms/confirm#",
      "https://htp.test/other/../forms/confirm",
      " https://htp.test/forms/confirm",
    ]
  ) equal(validVerifyUrl(value), false);
});
