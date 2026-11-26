-- Alert processor runner (inert). Adds only the service-only procedure that
-- drains the audit event queue. It creates NO schedule: supabase/cron/audit-events.sql
-- schedules it, and only the rollout operator applies that script.
--
-- Not SECURITY DEFINER and with no SET clause: PostgreSQL forbids transaction
-- control (COMMIT) in a procedure that has either. All callees are schema-qualified,
-- service-only SECURITY DEFINER functions, so the caller needs EXECUTE on them.
--
-- Per job: claim (committed, so the lease is durable), then in a fresh
-- READ COMMITTED transaction take the snapshot lock and run the processor, then
-- commit. A job whose processing raises is held as processor_unavailable so one
-- poison receipt cannot block the queue. While processing_enabled is false the
-- claim returns null and the procedure does nothing.
create procedure public.audit_event_run(p_max integer default 50)
language plpgsql as $$
declare c jsonb; n integer := 0;
begin
  if p_max is null or p_max < 1 or p_max > 500 then
    raise exception 'invalid_max' using errcode='22023';
  end if;
  while n < p_max loop
    c := public.audit_event_claim();
    exit when c is null;
    commit;
    n := n + 1;
    begin
      perform public.audit_event_snapshot_lock();
      perform public.audit_event_process((c->>'delivery_id')::uuid, (c->>'lease_token')::uuid);
    exception when others then
      -- The block's savepoint released the snapshot lock and any partial work.
      perform public.audit_event_hold((c->>'delivery_id')::uuid, (c->>'lease_token')::uuid, 'processor_unavailable');
    end;
    commit;
  end loop;
end $$;
revoke all on procedure public.audit_event_run(integer) from public, anon, authenticated;
grant execute on procedure public.audit_event_run(integer) to service_role;
