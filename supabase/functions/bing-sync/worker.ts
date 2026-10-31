import { openGrant, sealGrant } from "./crypto.ts";
import {
  BingError,
  type Config,
  fetchReport,
  type Job,
  refreshToken,
} from "./bing.ts";
type Rpc = (name: string, body: Record<string, unknown>) => Promise<unknown>;
export async function runSync(
  rpc: Rpc,
  config: Config,
  fetcher = fetch,
  now = Date.now,
) {
  let completed = 0, failed = 0, discarded = 0;
  const deadline = now() + 60_000;
  for (let i = 0; i < 6 && now() < deadline; i++) {
    const job = await rpc("claim_bing_report", {}) as Job | null;
    if (!job) break;
    let data = null, error = null;
    try {
      const grant = await openGrant(
        job.encrypted_grant,
        config.key,
        job.owner_id,
      );
      const token = await refreshToken(grant.refresh, config, fetcher);
      if (token.refresh && token.refresh !== grant.refresh) {
        const rotated = await rpc("rotate_bing_grant", {
          p_owner_id: job.owner_id,
          p_generation: job.generation,
          p_encrypted_grant: await sealGrant({
            ...grant,
            refresh: token.refresh,
          }, config.key),
        });
        if (!rotated) {
          discarded++;
          continue;
        }
      }
      data = await fetchReport(job, token.access, fetcher);
    } catch (cause) {
      error = cause instanceof BingError ? cause.code : "bing_unavailable";
    }
    const saved = await rpc("complete_bing_report", {
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
