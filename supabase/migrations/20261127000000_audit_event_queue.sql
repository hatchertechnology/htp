-- Receiver-first foundation. No processor or external delivery is enabled.
create table public.audit_event_config (
  singleton boolean primary key default true check (singleton),
  enqueue_enabled boolean not null default false,
  processing_enabled boolean not null default false,
  operations_enabled boolean not null default false
);
insert into public.audit_event_config(singleton) values(true);
alter table public.audit_event_config enable row level security;
revoke all on public.audit_event_config from public, anon, authenticated;

create table public.audit_event_jobs (
  delivery_id uuid primary key references public.seosmith_audits(delivery_id) on delete cascade,
  website_id uuid not null references public.websites(id) on delete cascade,
  fqdn text not null,
  generation bigint not null,
  state text not null default 'pending' check(state in ('pending','leased','held','processed')),
  lease_token uuid, leased_until timestamptz,
  hold_reason text,
  created_at timestamptz not null default now(),
  check ((state = 'held') = (hold_reason is not null)),
  check ((state = 'leased' and lease_token is not null and leased_until is not null) or (state <> 'leased' and lease_token is null and leased_until is null))
);
alter table public.audit_event_jobs enable row level security;
revoke all on public.audit_event_jobs from public, anon, authenticated;

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  fqdn text not null,
  generation bigint not null,
  delivery_id uuid not null references public.seosmith_audits(delivery_id) on delete cascade,
  baseline_id uuid not null references public.seosmith_audits(delivery_id) on delete cascade,
  semantics_version integer not null check (semantics_version > 0),
  entity_id text not null, rule text not null,
  kind text not null check (kind in ('new','reopened','severity_increased')),
  severity text not null check (severity in ('warning','alert','critical')),
  source_locator text not null,
  created_at timestamptz not null default now(),
  unique(semantics_version, website_id, delivery_id, entity_id, rule, kind)
);
create index audit_events_owner_history on public.audit_events(website_id, created_at desc, id desc);
alter table public.audit_events enable row level security;
revoke all on public.audit_events from public, anon, authenticated;

create function public.audit_enqueue_receipt() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.ingestion_source='worker' and new.summary->>'schema_version'='2'
     and (select enqueue_enabled from public.audit_event_config where singleton) then
    insert into public.audit_event_jobs(delivery_id,website_id,fqdn,generation)
      values(new.delivery_id,new.website_id,new.fqdn,new.generation) on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function public.audit_enqueue_receipt() from public, anon, authenticated;
create trigger audit_enqueue_receipt after insert on public.seosmith_audits for each row execute function public.audit_enqueue_receipt();

-- A claim serializes competing claimers; it performs no comparison or delivery.
-- Expired leases are reclaimable, and one binding has at most one active claim.
create function public.audit_event_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare enabled boolean; j public.audit_event_jobs;
begin
  select processing_enabled into enabled from public.audit_event_config where singleton for update;
  if not coalesce(enabled,false) then return null; end if;
  select candidate.* into j from public.audit_event_jobs candidate
  where (candidate.state='pending' or (candidate.state='leased' and candidate.leased_until<=now()))
    and not exists (select 1 from public.audit_event_jobs other
      where other.website_id=candidate.website_id and other.generation=candidate.generation
        and other.delivery_id<>candidate.delivery_id and other.state='leased' and other.leased_until>now())
  order by candidate.created_at,candidate.delivery_id limit 1 for update of candidate skip locked;
  if not found then return null; end if;
  update public.audit_event_jobs set state='leased',lease_token=gen_random_uuid(),leased_until=now()+interval '5 minutes'
    where delivery_id=j.delivery_id returning * into j;
  return jsonb_build_object('delivery_id',j.delivery_id,'website_id',j.website_id,'fqdn',j.fqdn,'generation',j.generation,'lease_token',j.lease_token,'leased_until',j.leased_until);
end $$;
revoke all on function public.audit_event_claim() from public,anon,authenticated;
grant execute on function public.audit_event_claim() to service_role;

-- Until the classifier is installed, a worker may only hold a claimed receipt.
create function public.audit_event_hold(p_delivery_id uuid,p_lease uuid,p_reason text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  if coalesce(p_reason,'') not in ('index_pending','history_unknown','late_or_tied','incompatible','processor_unavailable') then
    raise exception 'invalid_hold_reason' using errcode='22023';
  end if;
  update public.audit_event_jobs set state='held',hold_reason=p_reason,lease_token=null,leased_until=null
    where delivery_id=p_delivery_id and state='leased' and lease_token=p_lease and leased_until>now();
  return found;
end $$;
revoke all on function public.audit_event_hold(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.audit_event_hold(uuid,uuid,text) to service_role;

-- The caller must acquire this lock in a separate statement in the same
-- READ COMMITTED transaction before calling the processor. It conflicts with
-- receipt inserts, so the following statement sees a stable committed set.
create function public.audit_event_snapshot_lock() returns void language plpgsql security definer set search_path='' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'invalid_isolation' using errcode='22023'; end if;
  lock table public.seosmith_audits in share mode;
end $$;
revoke all on function public.audit_event_snapshot_lock() from public,anon,authenticated;
grant execute on function public.audit_event_snapshot_lock() to service_role;

-- Conservative v1 processor. A bounded complete history and exact source
-- evaluations are mandatory. Any uncertainty rolls back all candidate events
-- for this receipt and holds it. This deliberately does not infer a pass.
create function public.audit_event_process(p_delivery_id uuid,p_lease uuid) returns text
language plpgsql security definer set search_path='' as $$
declare j public.audit_event_jobs; a public.seosmith_audits; baseline public.seosmith_audits;
  ci record; ev record; prev jsonb; found_severity text; prior_severity text;
  event_kind text; prior_failed boolean; reason text; enabled boolean; n integer;
begin
  if current_setting('transaction_isolation') <> 'read committed' or not exists(
    select 1 from pg_catalog.pg_locks where pid=pg_backend_pid() and relation='public.seosmith_audits'::regclass and mode='ShareLock' and granted
  ) then raise exception 'snapshot_lock_required' using errcode='22023'; end if;
  select processing_enabled into enabled from public.audit_event_config where singleton;
  if not coalesce(enabled,false) then return 'disabled'; end if;
  select * into j from public.audit_event_jobs where delivery_id=p_delivery_id for update;
  if not found or j.state<>'leased' or j.lease_token is distinct from p_lease or j.leased_until<=now() then return 'lease_invalid'; end if;
  select * into a from public.seosmith_audits where delivery_id=j.delivery_id;
  begin
    if not exists(select 1 from public.websites where id=j.website_id and fqdn=j.fqdn)
      or a.ingestion_source<>'worker' or a.generation<>j.generation then raise exception 'incompatible'; end if;
    select * into ci from public.seosmith_lifecycle_indexed where delivery_id=a.delivery_id;
    if not found or ci.state<>'indexed_v1' or ci.evidence_truncated is distinct from false then raise exception 'index_pending'; end if;
    if ci.policy_digest is null or ci.comparison_key is null or ci.engine_version is null or ci.ruleset_version is null then raise exception 'incompatible'; end if;
    select count(*) into n from public.seosmith_audits x where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation;
    if n>100 or n<2 or jsonb_array_length(a.report->'findings')>1000 then raise exception 'history_unknown'; end if;
    if exists(select 1 from public.seosmith_audits x where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation and x.delivery_id<>a.delivery_id and x.scan_at>=a.scan_at) then raise exception 'late_or_tied'; end if;
    if exists(select 1 from public.seosmith_audits x left join public.seosmith_lifecycle_indexed i on i.delivery_id=x.delivery_id
      where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation and
      (x.ingestion_source<>'worker' or i.state is distinct from 'indexed_v1' or i.evidence_truncated is distinct from false
       or i.policy_digest is distinct from ci.policy_digest or i.comparison_key is distinct from ci.comparison_key
       or i.engine_version is distinct from ci.engine_version or i.ruleset_version is distinct from ci.ruleset_version)) then raise exception 'history_unknown'; end if;
    select * into baseline from public.seosmith_audits x where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation and x.scan_at<a.scan_at order by x.scan_at desc,x.delivery_id desc limit 1;
    if not found or jsonb_array_length(baseline.report->'findings')>1000 then raise exception 'history_unknown'; end if;
    if exists(select 1 from public.seosmith_audits x where x.website_id=j.website_id and x.fqdn=j.fqdn and x.generation=j.generation group by x.scan_at having count(*)>1) then raise exception 'late_or_tied'; end if;
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
    if reason not in ('incompatible','index_pending','history_unknown','late_or_tied') then raise; end if;
    update public.audit_event_jobs set state='held',hold_reason=reason,lease_token=null,leased_until=null where delivery_id=j.delivery_id;
    return 'held';
  end;
end $$;
revoke all on function public.audit_event_process(uuid,uuid) from public,anon,authenticated;
grant execute on function public.audit_event_process(uuid,uuid) to service_role;

-- Delivery is inert storage until destination authorization and a sender exist.
create table public.audit_event_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.audit_events(id) on delete cascade,
  destination_id uuid not null,
  channel text not null check(channel in ('email','webhook')),
  state text not null default 'pending' check(state in ('pending','leased','delivered','uncertain','dead')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  lease_token uuid, leased_until timestamptz, next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(event_id,destination_id,channel),
  check ((state='leased' and lease_token is not null and leased_until is not null) or (state<>'leased' and lease_token is null and leased_until is null))
);
alter table public.audit_event_deliveries enable row level security;
revoke all on public.audit_event_deliveries from public,anon,authenticated;

-- Explicit trusted completion hook; it is not attached to mutable job updates.
-- Reconnects, manual resets and deletion are not evidence of recovery.
create table public.audit_operational_episodes (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  fqdn text not null, source text not null check(source in ('google','bing','repository')),
  job_id uuid not null, error_class text not null check(error_class in ('provider_unavailable','authentication_required','rate_limited','other')),
  opened_at timestamptz not null default now(), recovered_at timestamptz
);
create unique index audit_operational_one_open on public.audit_operational_episodes(website_id,fqdn,source,job_id) where recovered_at is null;
alter table public.audit_operational_episodes enable row level security;
revoke all on public.audit_operational_episodes from public,anon,authenticated;
create function public.audit_operational_completion(p_site uuid,p_fqdn text,p_source text,p_job uuid,p_outcome text,p_error_class text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare eid uuid; enabled boolean; valid_job boolean;
begin
  select operations_enabled into enabled from public.audit_event_config where singleton;
  if not coalesce(enabled,false) then return null; end if;
  if coalesce(p_source,'') not in ('google','bing','repository') or coalesce(p_outcome,'') not in ('failed','recovered')
     or (p_outcome='failed' and coalesce(p_error_class,'') not in ('provider_unavailable','authentication_required','rate_limited','other'))
     or (p_outcome='recovered' and p_error_class is not null) then raise exception 'invalid_operation' using errcode='22023'; end if;
  perform 1 from public.websites where id=p_site and fqdn=p_fqdn for share;
  if not found then raise exception 'invalid_scope' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_site::text || ':' || p_source || ':' || p_job::text, 0));
  if p_source='google' then select exists(select 1 from public.google_report_jobs where id=p_job and website_id=p_site and fqdn=p_fqdn) into valid_job;
  elsif p_source='bing' then select exists(select 1 from public.bing_report_jobs where id=p_job and website_id=p_site and fqdn=p_fqdn) into valid_job;
  else select exists(select 1 from public.website_repositories where id=p_job and website_id=p_site and fqdn=p_fqdn) into valid_job; end if;
  if not valid_job then raise exception 'invalid_scope' using errcode='22023'; end if;
  if p_outcome='failed' then
    insert into public.audit_operational_episodes(website_id,fqdn,source,job_id,error_class)
      values(p_site,p_fqdn,p_source,p_job,p_error_class)
      on conflict (website_id,fqdn,source,job_id) where recovered_at is null do nothing returning id into eid;
    if eid is null then select id into eid from public.audit_operational_episodes where website_id=p_site and fqdn=p_fqdn and source=p_source and job_id=p_job and recovered_at is null; end if;
  else
    update public.audit_operational_episodes set recovered_at=now() where website_id=p_site and fqdn=p_fqdn and source=p_source and job_id=p_job and recovered_at is null returning id into eid;
  end if;
  return eid;
end $$;
revoke all on function public.audit_operational_completion(uuid,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.audit_operational_completion(uuid,text,text,uuid,text,text) to service_role;

-- An explicitly authorized owner reads retained events for the current FQDN only.
create function public.audit_event_history(p_website_id uuid, p_limit integer default 50, p_before timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; result jsonb; more boolean; last_row jsonb;
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
  return jsonb_build_object('semantics_version',1,'events',result,'has_more',more,'next_cursor',case when more then jsonb_build_object('before',last_row->>'created_at','before_id',last_row->>'id') else null end,'availability','producer_unavailable');
end $$;
revoke all on function public.audit_event_history(uuid,integer,timestamptz,uuid) from public, anon;
grant execute on function public.audit_event_history(uuid,integer,timestamptz,uuid) to authenticated;

create function public.audit_operational_history(p_website_id uuid,p_limit integer default 50,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; rows jsonb; more boolean; last_row jsonb;
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
  return jsonb_build_object('version',1,'episodes',rows,'has_more',more,'next_cursor',case when more then jsonb_build_object('before',last_row->>'opened_at','before_id',last_row->>'id') else null end,'availability','producer_unavailable');
end $$;
revoke all on function public.audit_operational_history(uuid,integer,timestamptz,uuid) from public,anon;
grant execute on function public.audit_operational_history(uuid,integer,timestamptz,uuid) to authenticated;
