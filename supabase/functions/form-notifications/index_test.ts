import { handle, run } from "./index.ts";
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
