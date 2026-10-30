import { openGrant, sealGrant } from "./crypto.ts";
import { fetchReport, type Job, refreshToken, SyncError } from "./google.ts";
export type Rpc = (
  name: string,
  body: Record<string, unknown>,
) => Promise<unknown>;
export interface Config {
  key: string;
  clientId: string;
  clientSecret: string;
}
export async function runSync(rpc: Rpc, config: Config, fetcher = fetch) {
  let completed = 0, failed = 0, discarded = 0;
  // Stay within Edge Function execution limits. Cron drains the remaining due
  // queue next minute; each successful job becomes due again one hour later.
  const deadline = Date.now() + 80_000;
  for (let i = 0; i < 2 && Date.now() < deadline; i++) {
    const job = await rpc("claim_google_report", {}) as Job | null;
    if (!job) break;
    let data = null, error = null;
    try {
      const grant = await openGrant(
        job.encrypted_grant,
        config.key,
        job.owner_id,
      );
      const token = await refreshToken(
        grant.refresh,
        config.clientId,
        config.clientSecret,
        fetcher,
      );
      if (token.refresh && token.refresh !== grant.refresh) {
        await rpc("rotate_google_grant", {
          p_owner_id: job.owner_id,
          p_generation: job.generation,
          p_encrypted_grant: await sealGrant({
            ...grant,
            refresh: token.refresh,
          }, config.key),
        });
      }
      data = await fetchReport(job, token.access, fetcher);
    } catch (cause) {
      error = cause instanceof SyncError ? cause.code : "google_unavailable";
    }
    const saved = await rpc("complete_google_report", {
      p_job_id: job.id,
      p_lease: job.lease,
      p_generation: job.generation,
      p_data: data,
      p_error: error,
    });
    if (!saved) discarded++;
    else if (error) failed++;
    else completed++;
  }
  return { completed, failed, discarded };
}
