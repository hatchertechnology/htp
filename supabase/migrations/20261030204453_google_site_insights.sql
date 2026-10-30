-- New integrations reuse the service-only leased queue and append-only snapshots.
alter table public.google_report_jobs drop constraint google_report_jobs_kind_check;
alter table public.google_report_jobs add constraint google_report_jobs_kind_check check
  (kind in ('analytics','search','properties','conversions','pagespeed','crux','business_locations','business_profile','business_performance'));

create table public.website_business_locations (
  website_id uuid not null references public.websites(id) on delete cascade,
  fqdn text not null,
  location_id text not null check (location_id ~ '^locations/[0-9]+$'),
  linked_at timestamptz not null default now(),
  primary key(website_id,fqdn,location_id)
);
create table public.google_profile_changes (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.google_report_jobs(id) on delete cascade,
  snapshot_id bigint not null references public.google_report_snapshots(id) on delete cascade,
  previous_snapshot_id bigint references public.google_report_snapshots(id) on delete cascade,
  observed_at timestamptz not null default now(),
  previous_observed_at timestamptz,
  field text not null,
  before_value jsonb,
  after_value jsonb,
  unique(snapshot_id,field)
);
create index google_profile_changes_history on public.google_profile_changes(job_id,observed_at desc,id desc);
alter table public.website_business_locations enable row level security;
alter table public.google_profile_changes enable row level security;
revoke all on public.website_business_locations,public.google_profile_changes from public,anon,authenticated;
grant all on public.website_business_locations,public.google_profile_changes to service_role;
revoke all on sequence public.google_profile_changes_id_seq from public,anon,authenticated;
grant usage,select on sequence public.google_profile_changes_id_seq to service_role;

create or replace function public.request_google_report(p_website_id uuid, p_kind text, p_property_id text,
  p_start_date date, p_end_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.websites; j public.google_report_jobs; s public.google_report_snapshots;
begin
  select * into w from public.websites where id = p_website_id and owner_id = auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous', 'true') = 'false' for no key update;
  if not found then raise insufficient_privilege using message = 'Website not found'; end if;
  if p_kind is null or p_kind not in ('analytics','search','properties','conversions','pagespeed','crux','business_locations','business_profile','business_performance') or p_property_id is null
    or length(p_property_id) > 2048 or p_start_date is null or p_end_date is null
    or p_end_date < p_start_date or p_end_date - p_start_date >= 366 then
    raise invalid_parameter_value using message = 'Invalid report';
  end if;
  if p_kind in ('analytics','conversions') and (w.ga4_property_id is null or w.ga4_property_id <> p_property_id) then
    raise invalid_parameter_value using message = 'Save the website GA4 property first';
  end if;
  if p_kind in ('pagespeed','crux','business_locations','business_profile') then
    if (p_kind='pagespeed' and p_property_id not in ('mobile','desktop'))
      or (p_kind='crux' and p_property_id not in ('PHONE','DESKTOP'))
      or (p_kind='business_locations' and p_property_id <> '') then
      raise invalid_parameter_value using message = 'Invalid source';
    end if;
    -- These are observations, not date-range reports. A single job preserves
    -- history continuously instead of fragmenting it by dashboard date range.
    p_start_date := date '1970-01-01'; p_end_date := date '1970-01-01';
  end if;
  if p_kind in ('business_profile','business_performance') and not exists
    (select 1 from public.website_business_locations where website_id=w.id and fqdn=w.fqdn and location_id=p_property_id) then
    raise invalid_parameter_value using message = 'Link an authorized Business Profile location first';
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
      when s.fetched_at < now() - case when j.kind in ('pagespeed','crux') then interval '26 hours' else interval '2 hours' end then 'stale' else 'ready' end,
    'fetched_at', s.fetched_at, 'last_error', j.last_error,
    'next_run_at', j.next_run_at, 'cadence', case when j.kind in ('pagespeed','crux') then 'daily' else 'hourly' end,
    'connection_status', (select status from public.google_connections where owner_id = w.owner_id)));
end $$;
revoke all on function public.request_google_report(uuid,text,text,date,date) from public, anon;
grant execute on function public.request_google_report(uuid,text,text,date,date) to authenticated;

create or replace function public.claim_google_report() returns jsonb
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
  -- Public performance data needs an API key, not a refreshed OAuth token.
  insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,refresh_until)
    select w.id,w.fqdn,k.kind,k.source,'1970-01-01','1970-01-01',now()+interval '7 days'
    from public.websites w join public.google_connections c on c.owner_id=w.owner_id
    cross join (values ('pagespeed','mobile'),('pagespeed','desktop'),('crux','PHONE'),('crux','DESKTOP'),('business_locations','')) k(kind,source)
    where c.status='connected' and (k.kind <> 'business_locations' or 'https://www.googleapis.com/auth/business.manage'=any(c.scopes))
    on conflict (website_id,fqdn,kind,property_id,start_date,end_date) do update set refresh_until=excluded.refresh_until;
  insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,refresh_until)
    select w.id,w.fqdn,'conversions',w.ga4_property_id,(now() at time zone 'UTC')::date-28,(now() at time zone 'UTC')::date-1,now()+interval '7 days'
    from public.websites w join public.google_connections c on c.owner_id=w.owner_id
    where c.status='connected' and w.ga4_property_id is not null and 'https://www.googleapis.com/auth/analytics.readonly'=any(c.scopes)
    on conflict (website_id,fqdn,kind,property_id,start_date,end_date) do update set refresh_until=excluded.refresh_until;
  insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,refresh_until)
    select w.id,w.fqdn,k.kind,b.location_id,
      case when k.kind='business_profile' then date '1970-01-01' else (now() at time zone 'UTC')::date-28 end,
      case when k.kind='business_profile' then date '1970-01-01' else (now() at time zone 'UTC')::date-1 end,now()+interval '7 days'
    from public.websites w join public.website_business_locations b on b.website_id=w.id and b.fqdn=w.fqdn
    join public.google_connections c on c.owner_id=w.owner_id
    cross join (values ('business_profile'),('business_performance')) k(kind)
    where c.status='connected' and 'https://www.googleapis.com/auth/business.manage'=any(c.scopes)
    on conflict (website_id,fqdn,kind,property_id,start_date,end_date) do update set refresh_until=excluded.refresh_until;
  select q.* into j from public.google_report_jobs q
    join public.websites w on w.id=q.website_id and w.fqdn=q.fqdn
    join public.google_connections c on c.owner_id=w.owner_id and c.status='connected'
    where q.next_run_at <= now() and q.refresh_until > now()
      and (q.leased_until is null or q.leased_until < now())
      and (q.kind not in ('analytics','conversions') or q.property_id=w.ga4_property_id)
      and (q.kind not in ('business_profile','business_performance') or exists
        (select 1 from public.website_business_locations b where b.website_id=w.id and b.fqdn=w.fqdn and b.location_id=q.property_id))
      and case when q.kind in ('analytics','conversions') then 'https://www.googleapis.com/auth/analytics.readonly'=any(c.scopes)
        when q.kind in ('pagespeed','crux') then true
        when q.kind like 'business_%' then 'https://www.googleapis.com/auth/business.manage'=any(c.scopes)
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

create or replace function public.complete_google_report(p_job_id uuid,p_lease uuid,p_generation uuid,
  p_data jsonb default null,p_error text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare j public.google_report_jobs; w public.websites; c public.google_connections; entry jsonb; site text; prev public.google_report_snapshots; saved_id bigint;
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
    or (j.kind in ('analytics','conversions') and w.ga4_property_id is distinct from j.property_id) then return false; end if;
  if j.kind in ('business_profile','business_performance') and not exists
    (select 1 from public.website_business_locations where website_id=w.id and fqdn=w.fqdn and location_id=j.property_id) then return false; end if;
  if p_error is null and p_data is not null then
    select * into prev from public.google_report_snapshots where job_id=j.id order by fetched_at desc,id desc limit 1;
    insert into public.google_report_snapshots(job_id,data) values(j.id,p_data) returning id into saved_id;
    if j.kind='business_profile' then
      if prev.id is null then
        insert into public.google_profile_changes(job_id,snapshot_id,field,after_value) values(j.id,saved_id,'__baseline',p_data->'location');
      else
        insert into public.google_profile_changes(job_id,snapshot_id,previous_snapshot_id,previous_observed_at,field,before_value,after_value)
          select j.id,saved_id,prev.id,prev.fetched_at,key,prev.data->'location'->key,p_data->'location'->key
          from (select jsonb_object_keys(coalesce(prev.data->'location','{}') || coalesce(p_data->'location','{}')) as key) keys
          where prev.data->'location'->key is distinct from p_data->'location'->key;
      end if;
    end if;
    update public.google_report_jobs set failures=0,last_error=null,next_run_at=now()+case when j.kind in ('pagespeed','crux') then interval '1 day' else interval '1 hour' end,lease=null,leased_until=null where id=j.id;
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
    if p_error not in ('google_authorization_required','google_access_denied','google_quota_exceeded','invalid_report','google_unavailable','integration_not_configured') then
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


-- Only bind locations returned by Google's discovery job for this website and
-- owner. No user-supplied result body or resource can grant provider access.
create function public.set_business_location(p_website_id uuid,p_location_id text,p_linked boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.websites; discovery jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous','true')='false' for no key update;
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  if p_location_id is null or p_location_id !~ '^locations/[0-9]+$' or p_linked is null then
    raise invalid_parameter_value using message='Invalid location'; end if;
  if p_linked then
    select s.data into discovery from public.google_report_snapshots s join public.google_report_jobs j on j.id=s.job_id
      where j.website_id=w.id and j.fqdn=w.fqdn and j.kind='business_locations' order by s.fetched_at desc,s.id desc limit 1;
    if not exists(select 1 from jsonb_array_elements(discovery->'locations') item where item->>'name'=p_location_id) then
      raise invalid_parameter_value using message='Choose a discovered location'; end if;
    if (select count(*) from public.website_business_locations where website_id=w.id and fqdn=w.fqdn)>=50
      and not exists(select 1 from public.website_business_locations where website_id=w.id and fqdn=w.fqdn and location_id=p_location_id) then
      raise program_limit_exceeded using message='Location limit reached'; end if;
    insert into public.website_business_locations(website_id,fqdn,location_id) values(w.id,w.fqdn,p_location_id) on conflict do nothing;
  else
    delete from public.website_business_locations where website_id=w.id and fqdn=w.fqdn and location_id=p_location_id;
    update public.google_report_jobs set lease=null,leased_until=null,refresh_until=now()
      where website_id=w.id and fqdn=w.fqdn and property_id=p_location_id and kind in ('business_profile','business_performance');
  end if;
  return jsonb_build_object('linked',p_linked,'location_id',p_location_id);
end $$;
revoke all on function public.set_business_location(uuid,text,boolean) from public,anon;
grant execute on function public.set_business_location(uuid,text,boolean) to authenticated;

-- History is read-only and remains accessible after disconnect/unlink. Raw
-- snapshots allow later reprocessing without reconstructing prior aggregates.
create function public.google_insight_history(p_website_id uuid,p_kind text,p_property_id text,
  p_start_date date,p_end_date date,p_before_id bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.websites; items jsonb; changes jsonb; bindings jsonb; comparison jsonb; health jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous','true')='false';
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  if p_kind is null or p_kind not in ('pagespeed','crux','conversions','business_locations','business_profile','business_performance')
    or p_property_id is null or length(p_property_id)>2048 or p_start_date is null or p_end_date is null
    or p_end_date<p_start_date or p_end_date-p_start_date>=366 then
    raise invalid_parameter_value using message='Invalid history range'; end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc),'[]') into items from (
    select s.id,s.fetched_at,case when j.kind='pagespeed' then jsonb_build_object('lighthouseResult',jsonb_build_object('categories',s.data->'lighthouseResult'->'categories')) when j.kind='business_profile' then null else s.data end as data,j.start_date,j.end_date from public.google_report_snapshots s join public.google_report_jobs j on j.id=s.job_id
    where j.website_id=w.id and j.fqdn=w.fqdn and j.kind=p_kind and j.property_id=p_property_id
      and s.fetched_at >= p_start_date::timestamp at time zone 'UTC' and s.fetched_at < (p_end_date+1)::timestamp at time zone 'UTC'
      and (p_before_id is null or s.id<p_before_id)
    order by s.id desc limit 201) t;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc),'[]') into changes from (
    select ch.* from public.google_profile_changes ch join public.google_report_jobs j on j.id=ch.job_id
    where j.website_id=w.id and j.fqdn=w.fqdn and j.kind=p_kind and j.property_id=p_property_id
      and ch.observed_at >= p_start_date::timestamp at time zone 'UTC' and ch.observed_at < (p_end_date+1)::timestamp at time zone 'UTC'
      and (p_before_id is null or ch.snapshot_id<p_before_id)
    order by ch.id desc limit 2001) t;
  select coalesce(jsonb_agg(location_id order by location_id),'[]') into bindings
    from public.website_business_locations where website_id=w.id and fqdn=w.fqdn;
  select coalesce(jsonb_object_agg(source.kind,source.data),'{}') into comparison from (
    select distinct on (j.kind) j.kind,s.data from public.google_report_jobs j
    join public.google_report_snapshots s on s.job_id=j.id
    where j.website_id=w.id and j.fqdn=w.fqdn and j.start_date=p_start_date and j.end_date=p_end_date
      and ((j.kind in ('analytics','conversions') and j.property_id=w.ga4_property_id)
        or (j.kind='business_performance' and j.property_id=p_property_id)
        or j.kind='search')
    order by j.kind,s.fetched_at desc,s.id desc) source;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.day,t.kind),'[]') into health from (
    select distinct on ((s.fetched_at at time zone 'UTC')::date,j.kind)
      (s.fetched_at at time zone 'UTC')::date as day,j.kind,
      case when j.kind='pagespeed' then jsonb_build_object('performance',s.data->'lighthouseResult'->'categories'->'performance'->'score')
        else jsonb_build_object('metrics',s.data->'record'->'metrics','collectionPeriod',s.data->'record'->'collectionPeriod') end as data
    from public.google_report_snapshots s join public.google_report_jobs j on j.id=s.job_id
    where j.website_id=w.id and j.fqdn=w.fqdn and ((j.kind='pagespeed' and j.property_id='mobile') or (j.kind='crux' and j.property_id='PHONE'))
      and s.fetched_at >= p_start_date::timestamp at time zone 'UTC' and s.fetched_at < (p_end_date+1)::timestamp at time zone 'UTC'
    order by (s.fetched_at at time zone 'UTC')::date,j.kind,s.fetched_at desc,s.id desc) t;
  return jsonb_build_object('comparison',comparison || jsonb_build_object('health',health),'snapshots',items,'changes',changes,'bindings',bindings,
    'has_more',jsonb_array_length(items)>200,'changes_truncated',jsonb_array_length(changes)>2000);
end $$;
revoke all on function public.google_insight_history(uuid,text,text,date,date,bigint) from public,anon;
grant execute on function public.google_insight_history(uuid,text,text,date,date,bigint) to authenticated;
