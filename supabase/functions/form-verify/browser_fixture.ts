import { handle } from "./index.ts";
const token = "a".repeat(64);
const digest = Array.from(
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ),
  (b) => b.toString(16).padStart(2, "0"),
).join("");
Deno.serve(
  { hostname: "127.0.0.1", port: 42581 },
  (request) => {
    console.log(request.method);
    return handle(request, {
      dashboardOrigin: "http://127.0.0.1:42580",
      challenge: (auth) =>
        Promise.resolve(
          auth === "Bearer valid"
            ? { hostname: "example.test", challenge_hash: digest }
            : null,
        ),
      dns: () =>
        Promise.resolve({
          Status: 0,
          Answer: [{
            type: 16,
            data: JSON.stringify(`htp-verification=${token}`),
          }],
        }),
      complete: () => Promise.resolve(true),
    });
  },
);
