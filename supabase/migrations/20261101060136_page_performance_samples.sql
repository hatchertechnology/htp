-- H09: bounded priority-page samples reuse the existing daily queue and fencing.
-- Deploy the URL-aware collector before this migration enables registration.
create function public.valid_performance_source(p_kind text,p_fqdn text,p_source text) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(length(p_source)<=2048 and
    case when strpos(p_source,'|')=0 then
      (p_kind='pagespeed' and p_source in ('mobile','desktop')) or
      (p_kind='crux' and p_source in ('PHONE','DESKTOP'))
    else
      ((p_kind='pagespeed' and split_part(p_source,'|',1) in ('mobile','desktop')) or
       (p_kind='crux' and split_part(p_source,'|',1) in ('PHONE','DESKTOP')))
      and starts_with(substr(p_source,strpos(p_source,'|')+1),'https://'||p_fqdn||'/')
      and substr(p_source,strpos(p_source,'|')+1) !~ '[[:space:]#|]'
      and strpos(p_source,chr(92))=0
    end,false)
$$;
revoke all on function public.valid_performance_source(text,text,text) from public,anon,authenticated;
grant execute on function public.valid_performance_source(text,text,text) to service_role;

create or replace function public.request_google_report(p_website_id uuid, p_kind text, p_property_id text,
  p_start_date date, p_end_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.websites; j public.google_report_jobs; s public.google_report_snapshots; target text;
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
    if (p_kind in ('pagespeed','crux') and not public.valid_performance_source(p_kind,w.fqdn,p_property_id))
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
  if p_kind like 'business_%' and not public.business_profile_enabled() then
    raise object_not_in_prerequisite_state using message = 'Business Profile integration is temporarily disabled';
  end if;
  if p_kind in ('pagespeed','crux') and strpos(p_property_id,'|') > 0 then
    target := substr(p_property_id,strpos(p_property_id,'|')+1);
    if not exists(select 1 from public.google_report_jobs where website_id=w.id and fqdn=w.fqdn
        and kind in ('pagespeed','crux') and refresh_until>now()
        and substr(property_id,strpos(property_id,'|')+1)=target and strpos(property_id,'|')>0)
      and (select count(distinct substr(property_id,strpos(property_id,'|')+1)) from public.google_report_jobs
        where website_id=w.id and fqdn=w.fqdn and kind in ('pagespeed','crux')
        and refresh_until>now() and strpos(property_id,'|')>0)>=10 then
      raise program_limit_exceeded using message='At most ten active sampled URLs per website';
    end if;
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


create or replace function public.google_insight_history(p_website_id uuid,p_kind text,p_property_id text,
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
    select s.id,s.fetched_at,case when j.kind='pagespeed' then (s.data - 'lighthouseResult') || jsonb_build_object('lighthouseResult',(s.data->'lighthouseResult') - 'audits' - 'fullPageScreenshot') when j.kind='business_profile' then null else s.data end as data,j.start_date,j.end_date from public.google_report_snapshots s join public.google_report_jobs j on j.id=s.job_id
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
  return jsonb_build_object('samples',(select coalesce(jsonb_agg(t.url order by t.url),'[]') from (
    select distinct substr(property_id,strpos(property_id,'|')+1) as url from public.google_report_jobs
    where website_id=w.id and fqdn=w.fqdn and kind in ('pagespeed','crux') and strpos(property_id,'|')>0
    order by url limit 200) t),'comparison',comparison || jsonb_build_object('health',health),'snapshots',items,'changes',changes,'bindings',bindings,
    'has_more',jsonb_array_length(items)>200,'changes_truncated',jsonb_array_length(changes)>2000);
end $$;
revoke all on function public.google_insight_history(uuid,text,text,date,date,bigint) from public,anon;
grant execute on function public.google_insight_history(uuid,text,text,date,date,bigint) to authenticated;
