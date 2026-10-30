-- Credentials and work queues are service-only. Users access saved reports solely
-- through the ownership-checking RPC below; no refresh token reaches a client.
create table public.google_connections (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  generation uuid not null default gen_random_uuid(),
  encrypted_grant text not null,
  scopes text[] not null,
  status text not null default 'connected' check (status in ('connected', 'reauthorization_required', 'disconnected')),
  updated_at timestamptz not null default now()
);
create table public.google_report_jobs (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  fqdn text not null,
  kind text not null check (kind in ('analytics', 'search', 'properties')),
  property_id text not null,
  start_date date not null,
  end_date date not null,
  refresh_until timestamptz not null default (now() + interval '7 days'),
  next_run_at timestamptz not null default now(),
  lease uuid,
  leased_until timestamptz,
  failures integer not null default 0,
  last_error text,
  unique (website_id, fqdn, kind, property_id, start_date, end_date),
  check (end_date >= start_date and end_date - start_date < 366)
);
create index google_report_jobs_due on public.google_report_jobs(next_run_at);
create table public.google_report_snapshots (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.google_report_jobs(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  data jsonb not null
);
create index google_report_snapshots_latest on public.google_report_snapshots(job_id, fetched_at desc, id desc);
alter table public.google_connections enable row level security;
alter table public.google_report_jobs enable row level security;
alter table public.google_report_snapshots enable row level security;
revoke all on public.google_connections, public.google_report_jobs, public.google_report_snapshots from public, anon, authenticated;
grant all on public.google_connections, public.google_report_jobs, public.google_report_snapshots to service_role;
grant usage, select on sequence public.google_report_snapshots_id_seq to service_role;
revoke all on sequence public.google_report_snapshots_id_seq from public, anon, authenticated;

-- Explicit SECURITY DEFINER boundary: every public call checks verified ownership
-- before reading or enqueueing anything. No caller can write provider results.
create function public.request_google_report(p_website_id uuid, p_kind text, p_property_id text,
  p_start_date date, p_end_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.websites; j public.google_report_jobs; s public.google_report_snapshots;
begin
  select * into w from public.websites where id = p_website_id and owner_id = auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous', 'true') = 'false' for no key update;
  if not found then raise insufficient_privilege using message = 'Website not found'; end if;
  if p_kind is null or p_kind not in ('analytics','search','properties') or p_property_id is null
    or length(p_property_id) > 2048 or p_start_date is null or p_end_date is null
    or p_end_date < p_start_date or p_end_date - p_start_date >= 366 then
    raise invalid_parameter_value using message = 'Invalid report';
  end if;
  if p_kind = 'analytics' and (w.ga4_property_id is null or w.ga4_property_id <> p_property_id) then
    raise invalid_parameter_value using message = 'Save the website GA4 property first';
  end if;
  -- Search property validation is repeated by the worker using parsed URLs.
  if p_kind = 'properties' and (p_property_id <> '' or p_start_date <> date '1970-01-01' or p_end_date <> date '1970-01-01') then
    raise invalid_parameter_value using message = 'Invalid property discovery request';
  end if;
  -- Serialize registrations per website to enforce the queue bound under concurrency.
  select * into j from public.google_report_jobs where website_id = w.id and fqdn = w.fqdn
    and kind = p_kind and property_id = p_property_id and start_date = p_start_date and end_date = p_end_date;
  if not found and (select count(*) from public.google_report_jobs where website_id = w.id
      and refresh_until > now()) >= 100 then
    raise program_limit_exceeded using message = 'Too many active report ranges';
  end if;
  insert into public.google_report_jobs(website_id, fqdn, kind, property_id, start_date, end_date)
    values(w.id, w.fqdn, p_kind, p_property_id, p_start_date, p_end_date)
    on conflict (website_id, fqdn, kind, property_id, start_date, end_date) do update
    set refresh_until = greatest(google_report_jobs.refresh_until, now() + interval '7 days')
    returning * into j;
  select * into s from public.google_report_snapshots where job_id = j.id order by fetched_at desc, id desc limit 1;
  return jsonb_build_object('data', s.data, 'sync', jsonb_build_object(
    'state', case when s.id is null then 'pending' when j.last_error is not null then 'error'
      when s.fetched_at < now() - interval '2 hours' then 'stale' else 'ready' end,
    'fetched_at', s.fetched_at, 'last_error', j.last_error,
    'next_run_at', j.next_run_at,
    'connection_status', (select status from public.google_connections where owner_id = w.owner_id)));
end $$;
revoke all on function public.request_google_report(uuid,text,text,date,date) from public, anon;
grant execute on function public.request_google_report(uuid,text,text,date,date) to authenticated;

-- One claim per transaction, using SKIP LOCKED and a fencing token. Multiple
-- Edge Function invocations can safely overlap; crashed work is retried.
create function public.claim_google_report() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.google_report_jobs; v_website public.websites; v_connection public.google_connections;
begin
  -- Seed continuous default collection, independently of dashboard visits.
  insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,refresh_until)
    select w.id,w.fqdn,'analytics',w.ga4_property_id,
      (now() at time zone 'UTC')::date - 28,(now() at time zone 'UTC')::date - 1,now() + interval '7 days'
    from public.websites w join public.google_connections c on c.owner_id=w.owner_id
    where c.status='connected' and w.ga4_property_id is not null
      and 'https://www.googleapis.com/auth/analytics.readonly'=any(c.scopes)
    on conflict (website_id,fqdn,kind,property_id,start_date,end_date) do update set refresh_until=excluded.refresh_until;
  insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,refresh_until)
    select w.id,w.fqdn,'properties','','1970-01-01','1970-01-01',now() + interval '7 days'
    from public.websites w join public.google_connections c on c.owner_id=w.owner_id
    where c.status='connected' and 'https://www.googleapis.com/auth/webmasters.readonly'=any(c.scopes)
    on conflict (website_id,fqdn,kind,property_id,start_date,end_date) do update set refresh_until=excluded.refresh_until;
  select q.* into j from public.google_report_jobs q
    join public.websites w on w.id=q.website_id and w.fqdn=q.fqdn
    join public.google_connections c on c.owner_id=w.owner_id and c.status='connected'
    where q.next_run_at <= now() and q.refresh_until > now()
      and (q.leased_until is null or q.leased_until < now())
      and (q.kind <> 'analytics' or q.property_id=w.ga4_property_id)
      and case when q.kind='analytics' then 'https://www.googleapis.com/auth/analytics.readonly'=any(c.scopes)
        else 'https://www.googleapis.com/auth/webmasters.readonly'=any(c.scopes) end
    order by q.next_run_at, q.id for update of q skip locked limit 1;
  if not found then return null; end if;
  update public.google_report_jobs set lease=gen_random_uuid(),leased_until=now()+interval '3 minutes'
    where id=j.id returning * into j;
  select * into v_website from public.websites where id=j.website_id;
  select * into v_connection from public.google_connections where owner_id=v_website.owner_id;
  return to_jsonb(j) || jsonb_build_object('owner_id',v_website.owner_id,'generation',v_connection.generation,'encrypted_grant',v_connection.encrypted_grant);
end $$;
revoke all on function public.claim_google_report() from public,anon,authenticated;
grant execute on function public.claim_google_report() to service_role;

create function public.complete_google_report(p_job_id uuid,p_lease uuid,p_generation uuid,
  p_data jsonb default null,p_error text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare j public.google_report_jobs; w public.websites; c public.google_connections; entry jsonb; site text;
begin
  select * into j from public.google_report_jobs where id=p_job_id;
  if not found then return false; end if;
  select * into w from public.websites where id=j.website_id for share;
  -- Lock the account before any job: property discovery can also update a
  -- search job, so all completions for an account must take locks in this order.
  select * into c from public.google_connections where owner_id=w.owner_id for update;
  select * into j from public.google_report_jobs where id=p_job_id and lease=p_lease and leased_until > now() for update;
  if not found then return false; end if;
  if c.generation is distinct from p_generation or c.status <> 'connected' or w.fqdn <> j.fqdn
    or (j.kind='analytics' and w.ga4_property_id is distinct from j.property_id) then return false; end if;
  if p_error is null and p_data is not null then
    insert into public.google_report_snapshots(job_id,data) values(j.id,p_data);
    update public.google_report_jobs set failures=0,last_error=null,next_run_at=now()+interval '1 hour',lease=null,leased_until=null where id=j.id;
    -- Search properties are discovered hourly. Collect the default matching
    -- property's rolling 28 days even if nobody opens the dashboard.
    if j.kind='properties' then
      select value into entry from jsonb_array_elements(p_data->'properties')
        order by case when value->>'siteUrl'='sc-domain:'||w.fqdn then 0 else 1 end, value->>'siteUrl' limit 1;
      site := entry->>'siteUrl';
      if site is not null then
        insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,refresh_until)
          values(w.id,w.fqdn,'search',site,(now() at time zone 'UTC')::date-28,
            (now() at time zone 'UTC')::date-1,now()+interval '7 days')
          on conflict (website_id,fqdn,kind,property_id,start_date,end_date) do update set refresh_until=excluded.refresh_until;
      end if;
    end if;
  else
    if p_error not in ('google_authorization_required','google_access_denied','google_quota_exceeded','invalid_report','google_unavailable') then
      p_error := 'google_unavailable';
    end if;
    update public.google_report_jobs set failures=least(failures+1,10),last_error=coalesce(p_error,'google_unavailable'),
      next_run_at=now()+make_interval(secs=>least(3600,60 * (2 ^ least(failures,6))::integer)),lease=null,leased_until=null where id=j.id;
    if p_error='google_authorization_required' then
      update public.google_connections set status='reauthorization_required',updated_at=now() where owner_id=w.owner_id;
    end if;
  end if;
  return true;
end $$;
revoke all on function public.complete_google_report(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.complete_google_report(uuid,uuid,uuid,jsonb,text) to service_role;

create function public.rotate_google_grant(p_owner_id uuid,p_generation uuid,p_encrypted_grant text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.google_connections set encrypted_grant=p_encrypted_grant,updated_at=now()
    where owner_id=p_owner_id and generation=p_generation and status='connected';
  return found;
end $$;
revoke all on function public.rotate_google_grant(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.rotate_google_grant(uuid,uuid,text) to service_role;
