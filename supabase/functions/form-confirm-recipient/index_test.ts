import { handle } from "./index.ts";
Deno.test("confirmation requires a valid token and posts it to privileged storage", async () => {
  const id = "00000000-0000-0000-0000-000000000001", token = "a".repeat(64);
  let called = false;
  const response = await handle(
    new Request("https://test/", {
      method: "POST",
      body: JSON.stringify({ recipient_id: id, token }),
    }),
    (actualId, actualToken) => {
      called = actualId === id && actualToken === token;
      return Promise.resolve(true);
    },
  );
  if (response.status !== 200 || !called) {
    throw new Error("confirmation failed");
  }
  const invalid = await handle(
    new Request("https://test/", { method: "POST", body: "{}" }),
    () => {
      throw new Error("must not call");
    },
  );
  if (invalid.status !== 400) throw new Error("invalid token accepted");
});
