-- Bing credentials and provider observations are service-only. Public RPCs
-- independently check non-anonymous ownership; clients cannot write reports.
create table public.bing_connections (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  generation uuid not null default gen_random_uuid(),
  encrypted_grant text not null,
  status text not null default 'connected' check (status in ('connected','reauthorization_required','disconnected')),
  updated_at timestamptz not null default now()
);
create table public.bing_report_jobs (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  fqdn text not null,
  next_run_at timestamptz not null default now(),
  lease uuid,
  leased_until timestamptz,
  failures integer not null default 0,
  last_error text,
  unique(website_id,fqdn)
);
create index bing_report_jobs_due on public.bing_report_jobs(next_run_at);
create table public.bing_report_snapshots (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.bing_report_jobs(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  data jsonb not null check (jsonb_typeof(data)='object')
);
create index bing_report_snapshots_latest on public.bing_report_snapshots(job_id,fetched_at desc,id desc);
alter table public.bing_connections enable row level security;
alter table public.bing_report_jobs enable row level security;
alter table public.bing_report_snapshots enable row level security;
revoke all on public.bing_connections,public.bing_report_jobs,public.bing_report_snapshots from public,anon,authenticated;
grant all on public.bing_connections,public.bing_report_jobs,public.bing_report_snapshots to service_role;
revoke all on sequence public.bing_report_snapshots_id_seq from public,anon,authenticated;
grant usage,select on sequence public.bing_report_snapshots_id_seq to service_role;

create function public.request_bing_report(p_website_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.websites; j public.bing_report_jobs; s public.bing_report_snapshots;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous','true')='false' for no key update;
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  insert into public.bing_report_jobs(website_id,fqdn) values(w.id,w.fqdn)
    on conflict(website_id,fqdn) do nothing;
  select * into j from public.bing_report_jobs where website_id=w.id and fqdn=w.fqdn;
  select * into s from public.bing_report_snapshots where job_id=j.id order by fetched_at desc,id desc limit 1;
  return jsonb_build_object('data',s.data,'sync',jsonb_build_object(
    'cadence','daily','state',case when j.last_error is not null then 'error' when s.id is null then 'pending'
      when s.fetched_at<now()-interval '26 hours' then 'stale' else 'ready' end,
    'fetched_at',s.fetched_at,'last_error',j.last_error,'next_run_at',j.next_run_at,
    'connection_status',(select status from public.bing_connections where owner_id=w.owner_id)));
end $$;
revoke all on function public.request_bing_report(uuid) from public,anon;
grant execute on function public.request_bing_report(uuid) to authenticated;

create function public.claim_bing_report() returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.bing_report_jobs; v_website public.websites; v_connection public.bing_connections;
begin
  insert into public.bing_report_jobs(website_id,fqdn)
    select w.id,w.fqdn from public.websites w join public.bing_connections c on c.owner_id=w.owner_id
    where c.status='connected' on conflict(website_id,fqdn) do nothing;
  select q.* into j from public.bing_report_jobs q
    join public.websites w on w.id=q.website_id and w.fqdn=q.fqdn
    join public.bing_connections c on c.owner_id=w.owner_id and c.status='connected'
    where q.next_run_at<=now() and (q.leased_until is null or q.leased_until<now())
    order by q.next_run_at,q.id for update of q skip locked limit 1;
  if not found then return null; end if;
  update public.bing_report_jobs set lease=gen_random_uuid(),leased_until=now()+interval '3 minutes'
    where id=j.id returning * into j;
  select * into v_website from public.websites where id=j.website_id;
  select * into v_connection from public.bing_connections where owner_id=v_website.owner_id;
  return to_jsonb(j)||jsonb_build_object('owner_id',v_website.owner_id,'generation',v_connection.generation,'encrypted_grant',v_connection.encrypted_grant);
end $$;
revoke all on function public.claim_bing_report() from public,anon,authenticated;
grant execute on function public.claim_bing_report() to service_role;

create function public.complete_bing_report(p_job_id uuid,p_lease uuid,p_generation uuid,p_data jsonb default null,p_error text default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare j public.bing_report_jobs; w public.websites; c public.bing_connections;
begin
  select * into j from public.bing_report_jobs where id=p_job_id;
  if not found then return false; end if;
  select * into w from public.websites where id=j.website_id for share;
  select * into c from public.bing_connections where owner_id=w.owner_id for update;
  select * into j from public.bing_report_jobs where id=p_job_id and lease=p_lease and leased_until>now() for update;
  if not found or c.generation is distinct from p_generation or c.status<>'connected' or w.fqdn<>j.fqdn then return false; end if;
  if p_error is null and p_data is not null then
    insert into public.bing_report_snapshots(job_id,data) values(j.id,p_data);
    update public.bing_report_jobs set failures=0,last_error=null,next_run_at=now()+interval '1 day',lease=null,leased_until=null where id=j.id;
  else
    if p_error is null or p_error not in ('bing_authorization_required','bing_access_denied','bing_quota_exceeded','bing_unavailable','invalid_report') then
      p_error:='bing_unavailable'; end if;
    update public.bing_report_jobs set failures=least(failures+1,10),last_error=p_error,
      next_run_at=now()+make_interval(secs=>least(3600,60*(2^least(failures,6))::integer)),lease=null,leased_until=null where id=j.id;
    if p_error='bing_authorization_required' then
      update public.bing_connections set status='reauthorization_required',updated_at=now() where owner_id=w.owner_id;
    end if;
  end if;
  return true;
end $$;
revoke all on function public.complete_bing_report(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.complete_bing_report(uuid,uuid,uuid,jsonb,text) to service_role;

create function public.rotate_bing_grant(p_owner_id uuid,p_generation uuid,p_encrypted_grant text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  update public.bing_connections set encrypted_grant=p_encrypted_grant,updated_at=now()
    where owner_id=p_owner_id and generation=p_generation and status='connected';
  return found;
end $$;
revoke all on function public.rotate_bing_grant(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.rotate_bing_grant(uuid,uuid,text) to service_role;

-- Extend the existing saved-evidence boundary without changing Google cursors.
-- Separate dataset names avoid mixing unrelated bigint snapshot sequences.
alter function public.website_saved_data(text,text,uuid,text,integer) rename to google_website_saved_data;
revoke all on function public.google_website_saved_data(text,text,uuid,text,integer) from public,anon,authenticated;
create function public.website_saved_data(p_fqdn text,p_dataset text,p_job_id uuid default null,p_before_id text default null,p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w public.websites; items jsonb; more boolean; job_cursor uuid; row_cursor bigint; result jsonb;
begin
  if p_dataset is null or p_dataset not in ('bing_sources','bing_snapshots') then
    result:=public.google_website_saved_data(p_fqdn,p_dataset,p_job_id,p_before_id,p_limit);
    if p_dataset='sources' then result:=result||jsonb_build_object('additional_datasets',jsonb_build_array('bing_sources','bing_snapshots')); end if;
    return result;
  end if;
  select * into w from public.websites where fqdn=p_fqdn and owner_id=auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous','true')='false';
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 then raise invalid_parameter_value using message='Invalid limit'; end if;
  if p_job_id is not null and not exists(select 1 from public.bing_report_jobs where id=p_job_id and website_id=w.id and fqdn=w.fqdn) then
    raise invalid_parameter_value using message='Invalid source'; end if;
  if p_before_id is not null then
    begin
      if p_dataset='bing_sources' then job_cursor:=p_before_id::uuid;
      else row_cursor:=p_before_id::bigint; if row_cursor<=0 then raise invalid_parameter_value; end if; end if;
    exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
      raise invalid_parameter_value using message='Invalid cursor';
    end;
  end if;
  if p_dataset='bing_sources' then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc),'[]'::jsonb) into items from (
      select j.id,j.fqdn,'bing'::text as kind,j.next_run_at,j.failures,j.last_error,s.id as latest_snapshot_id,s.fetched_at,
        case when j.last_error is not null then 'error' when s.id is null then 'pending'
          when s.fetched_at<now()-interval '26 hours' then 'stale' else 'ready' end as state
      from public.bing_report_jobs j left join lateral
        (select ss.id,ss.fetched_at from public.bing_report_snapshots ss where ss.job_id=j.id order by ss.fetched_at desc,ss.id desc limit 1) s on true
      where j.website_id=w.id and j.fqdn=w.fqdn and (p_job_id is null or j.id=p_job_id) and (job_cursor is null or j.id<job_cursor)
      order by j.id desc limit p_limit+1) t;
  else
    select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc),'[]'::jsonb) into items from (
      select s.id,s.job_id,s.fetched_at,s.data,j.fqdn,'bing'::text as kind
      from public.bing_report_snapshots s join public.bing_report_jobs j on j.id=s.job_id
      where j.website_id=w.id and j.fqdn=w.fqdn and (p_job_id is null or j.id=p_job_id) and (row_cursor is null or s.id<row_cursor)
      order by s.id desc limit p_limit+1) t;
  end if;
  more:=jsonb_array_length(items)>p_limit;
  if more then items:=items-p_limit; end if;
  return jsonb_build_object('fqdn',w.fqdn,'dataset',p_dataset,'items',items,'has_more',more,
    'next_cursor',case when more then items->(p_limit-1)->>'id' else null end,
    'connection_status',(select status from public.bing_connections where owner_id=w.owner_id));
end $$;
revoke all on function public.website_saved_data(text,text,uuid,text,integer) from public,anon;
grant execute on function public.website_saved_data(text,text,uuid,text,integer) to authenticated;

-- Reconnection starts collection immediately; a replaced grant cannot commit
-- work claimed with the preceding connection generation.
create function public.reset_bing_jobs() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.generation is distinct from new.generation then
    update public.bing_report_jobs set next_run_at=now(),lease=null,leased_until=null,
      failures=0,last_error=null where website_id in (select id from public.websites where owner_id=new.owner_id);
  end if;
  return new;
end $$;
revoke all on function public.reset_bing_jobs() from public,anon,authenticated;
create trigger bing_connection_generation after update on public.bing_connections
  for each row execute function public.reset_bing_jobs();
