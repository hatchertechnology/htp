-- Alert processor runner (inert). Adds the service-only procedure that drains the audit
-- event queue plus the helpers it needs. It creates NO schedule: supabase/cron/audit-events.sql
-- schedules it, and only the rollout operator applies that script.
--
-- Ordering. Claims are taken oldest-first by created_at (the enqueue transaction's start
-- time, not commit order), one job per transaction, so a binding's receipts are evaluated
-- strictly in receipt order, each against the state as of its own predecessor.
-- audit_event_process_ordered() is the 20261203000000 processor with the batch-ordering
-- artefact removed: a queued-but-newer receipt no longer holds an older one. Only a receipt that
-- is GENUINELY late (a newer receipt was already processed) or tied is held late_or_tied.
--
-- Errors. Deterministic contract outcomes are held by the processor. Transient errors (lock
-- timeout, deadlock, cancel, resource/connection class) leave the job pending, count an attempt
-- and stop the run; once the job has been failing for 30 minutes (first failure of the current
-- episode, not a tick count) it is held processor_unavailable. A failure more than 30 minutes
-- after the previous one starts a new episode. Other errors are deterministic poison and are
-- held at once. Every hold is visible in audit_event_queue_status.

create table public.audit_event_job_attempts (
  delivery_id uuid primary key references public.audit_event_jobs(delivery_id) on delete cascade,
  attempts integer not null default 0 check (attempts >= 0),
  last_sqlstate text, last_error text,
  first_failed_at timestamptz not null default now(),
  last_at timestamptz not null default now()
);
alter table public.audit_event_job_attempts enable row level security;
revoke all on public.audit_event_job_attempts from public, anon, authenticated;

create function public.audit_event_process_ordered(p_delivery_id uuid,p_lease uuid) returns text
language plpgsql security definer set search_path='' as $$
declare j public.audit_event_jobs; a public.seosmith_audits; baseline public.seosmith_audits;
  ci record; ev record; prev jsonb; found_severity text; prior_severity text;
  event_kind text; prior_failed boolean; reason text; enabled boolean; n integer;
  history_cap constant integer := 500;
begin
  if current_setting('transaction_isolation') <> 'read committed' or not exists(
    select 1 from pg_catalog.pg_locks where pid=pg_backend_pid() and relation='public.seosmith_audits'::regclass and mode='ShareLock' and granted
  ) then raise exception 'snapshot_lock_required' using errcode='22023'; end if;
  select processing_enabled into enabled from public.audit_event_config where singleton;
  if not coalesce(enabled,false) then
    update public.audit_event_jobs set state='pending',lease_token=null,leased_until=null where delivery_id=p_delivery_id and state='leased' and lease_token=p_lease;
    return 'disabled';
  end if;
  select * into j from public.audit_event_jobs where delivery_id=p_delivery_id for update;
  if not found or j.state<>'leased' or j.lease_token is distinct from p_lease or j.leased_until<=now() then return 'lease_invalid'; end if;
  select * into a from public.seosmith_audits where delivery_id=j.delivery_id;
  begin
    if not exists(select 1 from public.websites where id=j.website_id and fqdn=j.fqdn)
      or a.ingestion_source<>'worker' or a.generation<>j.generation then raise exception 'incompatible'; end if;
    select * into ci from public.seosmith_lifecycle_indexed where delivery_id=a.delivery_id;
    if not found or ci.state<>'indexed_v1' or ci.evidence_truncated is distinct from false then raise exception 'index_pending'; end if;
    if ci.policy_digest is null or ci.comparison_key is null or ci.engine_version is null or ci.ruleset_version is null then raise exception 'incompatible'; end if;
    -- History is bounded to receipts at or before this one: a newer receipt that is merely
    -- queued behind it (or not yet indexed) must never decide this receipt's outcome.
    select count(*) into n from public.seosmith_audits x where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation and x.scan_at<=a.scan_at;
    if jsonb_array_length(a.report->'findings')>1000 then raise exception 'history_unknown'; end if;
    if n>history_cap then raise exception 'history_capped'; end if;
    if n<2 then raise exception 'history_unknown'; end if;
    -- Tied scan time: baseline is ambiguous.
    if exists(select 1 from public.seosmith_audits x where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation and x.delivery_id<>a.delivery_id and x.scan_at=a.scan_at) then raise exception 'late_or_tied'; end if;
    -- Genuinely late: a newer receipt was already PROCESSED, so emitted events were computed without this one.
    if exists(select 1 from public.seosmith_audits x join public.audit_event_jobs xj on xj.delivery_id=x.delivery_id
      where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation and x.scan_at>a.scan_at and xj.state='processed') then raise exception 'late_or_tied'; end if;
    if exists(select 1 from public.seosmith_audits x left join public.seosmith_lifecycle_indexed i on i.delivery_id=x.delivery_id
      where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation and x.scan_at<=a.scan_at and
      (x.ingestion_source<>'worker' or i.state is distinct from 'indexed_v1' or i.evidence_truncated is distinct from false
       or i.policy_digest is distinct from ci.policy_digest or i.comparison_key is distinct from ci.comparison_key
       or i.engine_version is distinct from ci.engine_version or i.ruleset_version is distinct from ci.ruleset_version)) then raise exception 'history_unknown'; end if;
    select * into baseline from public.seosmith_audits x where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation and x.scan_at<a.scan_at order by x.scan_at desc,x.delivery_id desc limit 1;
    if not found or jsonb_array_length(baseline.report->'findings')>1000 then raise exception 'history_unknown'; end if;
    for ev in select entity_id,rule,evaluation from public.seosmith_lifecycle_evaluations where delivery_id=a.delivery_id and evaluation->>'outcome'='fail' loop
      if ev.evaluation->>'eligibility' is distinct from 'eligible' or ev.evaluation->>'attempt' is distinct from 'completed' or coalesce(ev.evaluation->>'source_locator','')='' then raise exception 'history_unknown'; end if;
      if exists(select 1 from public.seosmith_audits x left join public.seosmith_lifecycle_evaluations e on e.delivery_id=x.delivery_id and e.entity_id=ev.entity_id and e.rule=ev.rule
        where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation and x.scan_at<a.scan_at and
        (e.delivery_id is null or e.evaluation->>'eligibility' is distinct from 'eligible' or e.evaluation->>'attempt' is distinct from 'completed'
         or coalesce(e.evaluation->>'outcome','') not in ('pass','fail') or e.evaluation->>'rule_version' is distinct from ev.evaluation->>'rule_version'
         or e.evaluation->>'validator_version' is distinct from ev.evaluation->>'validator_version')) then raise exception 'history_unknown'; end if;
      select evaluation into prev from public.seosmith_lifecycle_evaluations where delivery_id=baseline.delivery_id and entity_id=ev.entity_id and rule=ev.rule;
      select count(*),min(f->>'severity') into n,found_severity from jsonb_array_elements(a.report->'findings') f where f->>'key'=ev.evaluation->>'finding_key';
      if n<>1 or coalesce(found_severity,'') not in ('warning','alert','critical') then raise exception 'history_unknown'; end if;
      event_kind:=null;
      if prev->>'outcome'='pass' then
        select exists(select 1 from public.seosmith_audits x join public.seosmith_lifecycle_evaluations e on e.delivery_id=x.delivery_id and e.entity_id=ev.entity_id and e.rule=ev.rule where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation and x.scan_at<baseline.scan_at and e.evaluation->>'outcome'='fail') into prior_failed;
        event_kind:=case when prior_failed then 'reopened' else 'new' end;
      else
        select count(*),min(f->>'severity') into n,prior_severity from jsonb_array_elements(baseline.report->'findings') f where f->>'key'=prev->>'finding_key';
        if n<>1 or coalesce(prior_severity,'') not in ('warning','alert','critical') then raise exception 'history_unknown'; end if;
        if array_position(array['warning','alert','critical'],found_severity)>array_position(array['warning','alert','critical'],prior_severity) then event_kind:='severity_increased'; end if;
      end if;
      if event_kind is not null then insert into public.audit_events(website_id,fqdn,generation,delivery_id,baseline_id,semantics_version,entity_id,rule,kind,severity,source_locator)
        values(j.website_id,j.fqdn,j.generation,a.delivery_id,baseline.delivery_id,1,ev.entity_id,ev.rule,event_kind,found_severity,ev.evaluation->>'source_locator') on conflict do nothing; end if;
    end loop;
    update public.audit_event_jobs set state='processed',lease_token=null,leased_until=null where delivery_id=j.delivery_id;
    return 'processed';
  exception when raise_exception then
    get stacked diagnostics reason=message_text;
    if reason not in ('incompatible','index_pending','history_unknown','late_or_tied','history_capped') then raise; end if;
    update public.audit_event_jobs set state='held',hold_reason=reason,lease_token=null,leased_until=null where delivery_id=j.delivery_id;
    return 'held';
  end;
end $$;
revoke all on function public.audit_event_process_ordered(uuid,uuid) from public,anon,authenticated;
grant execute on function public.audit_event_process_ordered(uuid,uuid) to service_role;

-- Records a failed attempt. Retryable: back to pending while the current failure episode is
-- younger than p_retry_window (measured from its first failure, so the budget is time, not
-- ticks); after that the job is held. A failure more than p_retry_window after the previous
-- one begins a new episode.
create function public.audit_event_run_fail(p_delivery_id uuid,p_lease uuid,p_sqlstate text,p_message text,p_retryable boolean,p_retry_window interval default interval '30 minutes')
returns text language plpgsql security definer set search_path='' as $$
declare first_at timestamptz;
begin
  perform 1 from public.audit_event_jobs where delivery_id=p_delivery_id and state='leased' and lease_token=p_lease for update;
  if not found then return 'lease_invalid'; end if;
  insert into public.audit_event_job_attempts as t(delivery_id,attempts,last_sqlstate,last_error)
    values(p_delivery_id,1,p_sqlstate,left(p_message,500))
    on conflict (delivery_id) do update set
      attempts=case when t.last_at < now()-p_retry_window then 1 else t.attempts+1 end,
      first_failed_at=case when t.last_at < now()-p_retry_window then now() else t.first_failed_at end,
      last_sqlstate=excluded.last_sqlstate,last_error=excluded.last_error,last_at=now()
    returning t.first_failed_at into first_at;
  if p_retryable and now() - first_at < p_retry_window then
    update public.audit_event_jobs set state='pending',lease_token=null,leased_until=null where delivery_id=p_delivery_id;
    return 'retry';
  end if;
  update public.audit_event_jobs set state='held',hold_reason='processor_unavailable',lease_token=null,leased_until=null where delivery_id=p_delivery_id;
  return 'held';
end $$;
revoke all on function public.audit_event_run_fail(uuid,uuid,text,text,boolean,interval) from public,anon,authenticated;
grant execute on function public.audit_event_run_fail(uuid,uuid,text,text,boolean,interval) to service_role;

-- Countable queue state: every held job, by reason, is visible here (late_or_tied,
-- history_capped, history_unknown, index_pending, incompatible, processor_unavailable).
create view public.audit_event_queue_status as
select j.state, j.hold_reason, count(*)::bigint as jobs, min(j.created_at) as oldest_created_at,
       coalesce(max(a.attempts),0) as max_attempts
from public.audit_event_jobs j left join public.audit_event_job_attempts a on a.delivery_id=j.delivery_id
group by j.state, j.hold_reason;
revoke all on public.audit_event_queue_status from public, anon, authenticated;
grant select on public.audit_event_queue_status to service_role;

-- Runner liveness, written by the procedure and read by the history RPCs below. One row.
create table public.audit_event_run_state (
  singleton boolean primary key default true check (singleton),
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_outcome text check (last_outcome in ('success','retry'))
);
insert into public.audit_event_run_state(singleton) values(true);
alter table public.audit_event_run_state enable row level security;
revoke all on public.audit_event_run_state from public, anon, authenticated;

-- No-op while processing is disabled, so a disabled gate never looks like a healthy runner.
create function public.audit_event_run_mark(p_ok boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
  if not coalesce((select processing_enabled from public.audit_event_config where singleton),false) then return; end if;
  update public.audit_event_run_state set last_run_at=now(),
    last_success_at=case when p_ok then now() else last_success_at end,
    last_outcome=case when p_ok then 'success' else 'retry' end where singleton;
end $$;
revoke all on function public.audit_event_run_mark(boolean) from public,anon,authenticated;
grant execute on function public.audit_event_run_mark(boolean) to service_role;

-- Not SECURITY DEFINER and with no SET clause: PostgreSQL forbids transaction control
-- (COMMIT) in a procedure that has either. All callees are schema-qualified, service-only
-- SECURITY DEFINER functions. Per job: claim (committed so the lease is durable), then a fresh
-- READ COMMITTED transaction takes the snapshot lock under a 5s lock_timeout, processes, commits.
-- Overlapping runs are safe (claims serialize on the config row); an advisory-lock guard is not
-- used because a session lock would leak on error (COMMIT forbids an enclosing handler).
create procedure public.audit_event_run(p_max integer default 50)
language plpgsql as $$
declare c jsonb; n integer := 0; r text; st text; msg text; retry boolean; ok boolean := true;
begin
  if p_max is null or p_max < 1 or p_max > 500 then
    raise exception 'invalid_max' using errcode='22023';
  end if;
  -- Misconfiguration fails the whole call loudly, once, instead of holding every job.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'invalid_isolation' using errcode='22023';
  end if;
  while n < p_max loop
    c := public.audit_event_claim();
    exit when c is null;
    commit;
    n := n + 1;
    perform set_config('lock_timeout','5s',true);
    begin
      perform public.audit_event_snapshot_lock();
      r := public.audit_event_process_ordered((c->>'delivery_id')::uuid, (c->>'lease_token')::uuid);
    exception when others then
      -- The block's savepoint released the snapshot lock and any partial work.
      get stacked diagnostics st = returned_sqlstate, msg = message_text;
      retry := st in ('55P03','40P01','40001','57014') or st like '53%' or st like '08%' or st like '57P%'
               or (st = '22023' and msg in ('invalid_isolation','snapshot_lock_required'));
      r := public.audit_event_run_fail((c->>'delivery_id')::uuid, (c->>'lease_token')::uuid, st, msg, retry);
    end;
    commit;
    -- A retry (the lock or database is struggling) and a disabled gate both stop this run;
    -- the next tick resumes, so a binding is never processed out of receipt order.
    if r = 'retry' then ok := false; end if;
    exit when r in ('retry','disabled');
  end loop;
  perform public.audit_event_run_mark(ok);
  commit;
end $$;
revoke all on procedure public.audit_event_run(integer) from public, anon, authenticated;
grant execute on procedure public.audit_event_run(integer) to service_role;

-- WP3 reassignment: the stored-history reads report the real producer state instead of a literal.
-- Real producer state for the stored-history reads. availability is a stable code:
--   producer_unavailable   processing is disabled (the gates are off)
--   producer_not_enqueuing processing is on but receipt enqueue is off
--   producer_starting      enabled, but the runner has not run since it was enabled
--   producer_stale         the runner has not run for 5 minutes (cron stopped or failing)
--   producer_degraded      the last run hit transient errors, or this site has a job held processor_unavailable
--   producer_active        the runner is running normally
-- The producer object carries the gate flags, last_run_at, last_success_at, last_outcome and this
-- site's unprocessed job counts (pending includes leased); counts are capped at 1000 rows and
-- counts_capped says when they are lower bounds. A history that is not producer_active is not
-- proof that no events exist.
create function public.audit_event_producer_state(p_website_id uuid,p_fqdn text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare cfg public.audit_event_config; rs public.audit_event_run_state; code text; pend integer; held integer; capped boolean; by_reason jsonb;
begin
  select * into cfg from public.audit_event_config where singleton;
  select * into rs from public.audit_event_run_state where singleton;
  with u as (select state,hold_reason from public.audit_event_jobs where website_id=p_website_id and fqdn=p_fqdn and state<>'processed' limit 1001),
       g as (select state,hold_reason,count(*) n from u group by 1,2)
  select coalesce(sum(n) filter (where state in ('pending','leased')),0), coalesce(sum(n) filter (where state='held'),0),
         (select count(*) from u)>1000,
         coalesce(jsonb_object_agg(hold_reason,n) filter (where state='held'),'{}'::jsonb)
    into pend,held,capped,by_reason from g;
  code:=case
    when not coalesce(cfg.processing_enabled,false) then 'producer_unavailable'
    when not coalesce(cfg.enqueue_enabled,false) then 'producer_not_enqueuing'
    when rs.last_run_at is null then 'producer_starting'
    when rs.last_run_at < now()-interval '5 minutes' then 'producer_stale'
    when rs.last_outcome='retry' or coalesce((by_reason->>'processor_unavailable')::int,0)>0 then 'producer_degraded'
    else 'producer_active' end;
  return jsonb_build_object('availability',code,'producer',jsonb_build_object(
    'processing_enabled',coalesce(cfg.processing_enabled,false),'enqueue_enabled',coalesce(cfg.enqueue_enabled,false),
    'last_run_at',rs.last_run_at,'last_success_at',rs.last_success_at,'last_outcome',rs.last_outcome,
    'pending',pend,'held',held,'held_by_reason',by_reason,'counts_capped',capped));
end $$;
revoke all on function public.audit_event_producer_state(uuid,text) from public,anon,authenticated;
grant execute on function public.audit_event_producer_state(uuid,text) to service_role;

create or replace function public.audit_event_history(p_website_id uuid, p_limit integer default 50, p_before timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; result jsonb; more boolean; last_row jsonb; pstate jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 or (p_before is null)<>(p_before_id is null) then raise exception 'invalid_cursor_or_limit' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc,e.id desc),'[]'::jsonb) into result
    from (select id,delivery_id,baseline_id,semantics_version,entity_id,rule,kind,severity,source_locator,created_at
          from public.audit_events where website_id=w.id and fqdn=w.fqdn and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit p_limit+1) e;
  more := jsonb_array_length(result)>p_limit;
  if more then result := result-p_limit; end if;
  last_row:=result->(jsonb_array_length(result)-1);
  pstate:=public.audit_event_producer_state(w.id,w.fqdn);
  return jsonb_build_object('semantics_version',1,'events',result,'has_more',more,'next_cursor',case when more then jsonb_build_object('before',last_row->>'created_at','before_id',last_row->>'id') else null end,'availability',pstate->>'availability','producer',pstate->'producer');
end $$;
revoke all on function public.audit_event_history(uuid,integer,timestamptz,uuid) from public, anon;
grant execute on function public.audit_event_history(uuid,integer,timestamptz,uuid) to authenticated;

create or replace function public.audit_operational_history(p_website_id uuid,p_limit integer default 50,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; rows jsonb; more boolean; last_row jsonb; ops boolean;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 or (p_before is null)<>(p_before_id is null) then raise exception 'invalid_cursor_or_limit' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.opened_at desc,e.id desc),'[]'::jsonb) into rows
    from (select id,source,job_id,error_class,opened_at,recovered_at from public.audit_operational_episodes
      where website_id=w.id and fqdn=w.fqdn and (p_before is null or (opened_at,id)<(p_before,p_before_id)) order by opened_at desc,id desc limit p_limit+1) e;
  more:=jsonb_array_length(rows)>p_limit;
  if more then rows:=rows-p_limit; end if;
  last_row:=rows->(jsonb_array_length(rows)-1);
  select operations_enabled into ops from public.audit_event_config where singleton;
  return jsonb_build_object('version',1,'episodes',rows,'has_more',more,'next_cursor',case when more then jsonb_build_object('before',last_row->>'opened_at','before_id',last_row->>'id') else null end,'availability',case when coalesce(ops,false) then 'producer_active' else 'producer_unavailable' end,'producer',jsonb_build_object('operations_enabled',coalesce(ops,false)));
end $$;
revoke all on function public.audit_operational_history(uuid,integer,timestamptz,uuid) from public,anon;
grant execute on function public.audit_operational_history(uuid,integer,timestamptz,uuid) to authenticated;
