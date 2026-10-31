import { authorized } from "./crypto.ts";
import { runSync } from "./worker.ts";
const required = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error("bing_sync_not_configured");
  return value;
};
export async function handle(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (
    !await authorized(
      request.headers.get("x-htp-sync-secret"),
      Deno.env.get("BING_SYNC_SECRET") ?? "",
    )
  ) return new Response(null, { status: 401 });
  try {
    const url = required("SUPABASE_URL"),
      service = required("SUPABASE_SERVICE_ROLE_KEY");
    const rpc = async (name: string, body: Record<string, unknown>) => {
      const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
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
    };
    const result = await runSync(rpc, {
      key: required("BING_GRANT_KEY"),
      clientId: required("BING_CLIENT_ID"),
      clientSecret: required("BING_CLIENT_SECRET"),
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error(
      "Bing sync could not complete; check database and function configuration.",
    );
    return Response.json({ error: "bing_sync_unavailable" }, { status: 503 });
  }
}
if (import.meta.main) Deno.serve(handle);
