-- Stops the audit event runner. Pair with 20261203000000_audit_notifications_disable.sql
-- to also close the gates. Retains the procedure, jobs, events and episodes.
select cron.unschedule(jobid) from cron.job where jobname = 'htp-audit-events';
do $$ begin
  if exists (select 1 from cron.job where jobname = 'htp-audit-events') then
    raise exception 'htp-audit-events still scheduled';
  end if;
end $$;
