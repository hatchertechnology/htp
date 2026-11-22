import { limitedBody } from "../_shared/limited_body.ts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function handle(
  request: Request,
  confirm: (id: string, token: string) => Promise<boolean>,
): Promise<Response> {
  const reply = (value: unknown, status: number) =>
    Response.json(value, {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  if (request.method !== "POST") {
    return reply({ error: "method_not_allowed" }, 405);
  }
  let data: unknown;
  try {
    data = JSON.parse(await limitedBody(request, 1024));
  } catch {
    return reply({ error: "invalid_request" }, 400);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return reply({ error: "invalid_request" }, 400);
  }
  const { recipient_id, token } = data as Record<string, unknown>;
  if (
    typeof recipient_id !== "string" || !uuid.test(recipient_id) ||
    typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)
  ) return reply({ error: "invalid_request" }, 400);
  try {
    return await confirm(recipient_id, token)
      ? reply({ ok: true }, 200)
      : reply({ error: "invalid_or_expired" }, 422);
  } catch {
    return reply({ error: "temporarily_unavailable" }, 503);
  }
}
if (import.meta.main) {
  const base = Deno.env.get("SUPABASE_URL") ?? "",
    service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  Deno.serve((request) =>
    handle(request, async (id, token) => {
      if (!base || !service) throw new Error("not_configured");
      const response = await fetch(
        `${base}/rest/v1/rpc/confirm_form_recipient`,
        {
          method: "POST",
          headers: {
            apikey: service,
            Authorization: `Bearer ${service}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ p_recipient_id: id, p_token: token }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error("unavailable");
      return await response.json();
    })
  );
}
