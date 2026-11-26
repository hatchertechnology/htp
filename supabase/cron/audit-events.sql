-- Schedules the audit event runner. Apply only after migration 20261214000000 and
-- after audit_event_config gates are verified (operations, then enqueue+processing).
-- The runner is a no-op while processing_enabled is false.
-- Rollback: supabase/rollbacks/20261214000000_audit_event_runner_unschedule.sql
create extension if not exists pg_cron;

-- Idempotent installation.
select cron.unschedule(jobid) from cron.job where jobname = 'htp-audit-events';
select cron.schedule('htp-audit-events', '* * * * *', $cron$call public.audit_event_run(50);$cron$);
