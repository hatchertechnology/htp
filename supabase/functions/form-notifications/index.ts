import { authorized } from "../bing-sync/crypto.ts";
type Job = {
  id: string;
  lease: string;
  kind: "verification" | "response";
  recipient_id: string;
  email: string;
  token: string | null;
  form_name: string;
  reply_to: string | null;
};
type Dependencies = {
  claim: () => Promise<Job | null>;
  finish: (
    id: string,
    lease: string,
    state: "sent" | "failed" | "uncertain",
  ) => Promise<boolean>;
  send: (
    message: Record<string, string>,
  ) => Promise<"sent" | "failed" | "uncertain">;
  sender: string;
  verifyUrl: string;
};
export async function run(deps: Dependencies) {
  const job = await deps.claim();
  if (!job) return { processed: false };
  let state: "sent" | "failed" | "uncertain" = "uncertain";
  try {
    const message: Record<string, string> = {
      From: deps.sender,
      To: job.email,
      Subject: job.kind === "verification"
        ? "Confirm form notifications"
        : "New website inquiry",
    };
    if (job.kind === "verification") {
      if (!job.token) throw new Error("missing_token");
      message.TextBody =
        `Confirm that you want to receive form notifications by opening this link and choosing Confirm:\n\n${deps.verifyUrl}#${job.recipient_id}:${job.token}\n\nThis link expires in 24 hours.`;
    } else {
      message.TextBody =
        `A new inquiry was received for ${job.form_name}. Sign in to Hatch Tech Platform to review it.`;
      if (
        job.reply_to && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(job.reply_to)
      ) message.ReplyTo = job.reply_to;
    }
    state = await deps.send(message);
  } catch {
    state = "uncertain";
  }
  await deps.finish(job.id, job.lease, state);
  return { processed: true, state };
}
export async function handle(
  request: Request,
  secret: string,
  deps: Dependencies,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!await authorized(request.headers.get("x-htp-sync-secret"), secret)) {
    return new Response(null, { status: 401 });
  }
  try {
    return Response.json(await run(deps), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "delivery_unavailable" }, { status: 503 });
  }
}
if (import.meta.main) {
  const env = (key: string) => Deno.env.get(key) ?? "";
  const base = env("SUPABASE_URL"),
    service = env("SUPABASE_SERVICE_ROLE_KEY"),
    sender = env("FORMS_SENDER"),
    verifyUrl = env("FORMS_VERIFY_URL"),
    postmark = env("POSTMARK_SERVER_TOKEN"),
    secret = env("FORMS_NOTIFICATION_SECRET");
  async function rpc(name: string, body: unknown) {
    const response = await fetch(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: service,
        Authorization: `Bearer ${service}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("database_unavailable");
    return await response.json();
  }
  Deno.serve((request) => {
    if (
      !base || !service || !sender || !postmark || !secret ||
      !/^https:\/\//.test(verifyUrl)
    ) {
      return Response.json({ error: "delivery_not_configured" }, {
        status: 503,
      });
    }
    return handle(request, secret, {
      sender,
      verifyUrl,
      claim: () => rpc("claim_form_delivery", {}),
      finish: (id, lease, state) =>
        rpc("finish_form_delivery", {
          p_job_id: id,
          p_lease: lease,
          p_state: state,
        }),
      send: async (message) => {
        try {
          const response = await fetch("https://api.postmarkapp.com/email", {
            method: "POST",
            headers: {
              "X-Postmark-Server-Token": postmark,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(message),
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
          if (response.ok) return "sent";
          return response.status >= 400 && response.status < 500
            ? "failed"
            : "uncertain";
        } catch {
          return "uncertain";
        }
      },
    });
  });
}
