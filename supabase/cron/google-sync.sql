-- Run AFTER deploying google-sync and creating these Vault secrets:
-- htp_project_url: https://<project-ref>.supabase.co
-- htp_google_sync_secret: same random secret as Edge GOOGLE_SYNC_SECRET
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Idempotent installation. The minute tick drains bounded batches; each report
-- is fetched at most hourly after success, as recorded by next_run_at.
select cron.unschedule(jobid) from cron.job where jobname = 'htp-google-sync';
select cron.schedule('htp-google-sync', '* * * * *', $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='htp_project_url') || '/functions/v1/google-sync',
    headers := jsonb_build_object('Content-Type','application/json','x-htp-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='htp_google_sync_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
$cron$);
