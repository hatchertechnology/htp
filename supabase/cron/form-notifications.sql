-- Run after deploying form-notifications and setting Vault secrets
-- htp_project_url and htp_forms_notification_secret (matching the function).
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.unschedule(jobid) from cron.job where jobname = 'htp-form-notifications';
select cron.schedule('htp-form-notifications', '* * * * *', $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='htp_project_url') || '/functions/v1/form-notifications',
    headers := jsonb_build_object('Content-Type','application/json','x-htp-sync-secret',
      (select decrypted_secret from vault.decrypted_secrets where name='htp_forms_notification_secret')),
    body := '{}'::jsonb,
    -- Claim (10s), provider (15s), and finish (10s), plus 15s for overhead.
    timeout_milliseconds := 50000
  );
$cron$);
