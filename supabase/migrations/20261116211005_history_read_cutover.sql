create or replace function public.history_day(p_value text, p_bing boolean default false) returns date
language plpgsql immutable set search_path='' as $$
declare v text; d date; m text[]; minutes integer;
begin
  if p_bing and p_value ~ '^/Date\(-?[0-9]+([+-][0-9]{4})?\)/$' then
    m := regexp_match(p_value, '^/Date\((-?[0-9]+)([+-][0-9]{4})?\)/$');
    minutes := case when m[2] is null then 0 else
      (substring(m[2],2,2)::integer*60+substring(m[2],4,2)::integer)
        * case when left(m[2],1)='-' then -1 else 1 end end;
    if abs(minutes)>14*60 or (m[2] is not null and substring(m[2],4,2)::integer>=60) then return null; end if;
    d := (to_timestamp(m[1]::double precision/1000) at time zone 'UTC' + make_interval(mins=>minutes))::date;
    if d < date '2000-01-01' or d > date '9999-12-31' then return null; end if;
    return d;
  end if;
  if p_bing and p_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then p_value := left(p_value,10); end if;
  v := case when p_value ~ '^[0-9]{8}$' then
    substring(p_value,1,4)||'-'||substring(p_value,5,2)||'-'||substring(p_value,7,2)
    else p_value end;
  if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  d := v::date;
  if to_char(d,'YYYY-MM-DD') <> v then return null; end if;
  if p_bing and (d < date '2000-01-01' or d > date '9999-12-31') then return null; end if;
  return d;
exception when datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then return null;
end $$;

-- Stored read cutover. Apply only after canonical backfill and comparison.
create or replace function public.request_google_report(p_website_id uuid, p_kind text, p_property_id text,
  p_start_date date, p_end_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare w public.websites; j public.google_report_jobs; s public.google_report_snapshots; h jsonb; doc jsonb; daily jsonb; totals jsonb; headers jsonb; fetched timestamptz;
begin
  select * into w from public.websites where id = p_website_id and owner_id = auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous', 'true') = 'false';
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
  -- Search property validation is repeated by the worker using parsed URLs.
  if p_kind = 'properties' and (p_property_id <> '' or p_start_date <> date '1970-01-01' or p_end_date <> date '1970-01-01') then
    raise invalid_parameter_value using message = 'Invalid property discovery request';
  end if;
  -- Reads never register or renew collection work.
  select * into j from public.google_report_jobs where website_id=w.id and fqdn=w.fqdn
    and kind=p_kind and property_id=p_property_id and start_date=p_start_date and end_date=p_end_date;
  select * into s from public.google_report_snapshots where job_id=j.id order by fetched_at desc,id desc limit 1;
  doc := s.data; fetched := s.fetched_at;
  if p_kind in ('analytics','conversions','search') then
    h := public.read_daily_history(w.id,p_kind,p_property_id,p_start_date,p_end_date);
    select coalesce(max((v->>'fetched_at')::timestamptz),s.fetched_at) into fetched from jsonb_array_elements(h->'daily') v;
    if p_kind='search' then
      select jsonb_build_object('rows',coalesce(jsonb_agg(v->'row' order by v->>'date'),'[]')) into daily
        from jsonb_array_elements(h->'daily') v;
      select jsonb_build_object('clicks',sum((v#>>'{row,clicks}')::numeric),
        'impressions',sum((v#>>'{row,impressions}')::numeric)) into totals from jsonb_array_elements(h->'daily') v;
      doc := coalesce(doc,'{"summary":{"rows":[]},"queries":{"rows":[]},"pages":{"rows":[]}}'::jsonb) || jsonb_build_object('site_url',p_property_id,'start_date',p_start_date,'end_date',p_end_date);
      if jsonb_array_length(h->'daily')>0 then
        doc := jsonb_set(doc,'{summary}',jsonb_build_object('rows',jsonb_build_array(
          coalesce(doc#>'{summary,rows,0}','{}') || totals)));
      end if;
    else
      -- Align each day's metric values by header name, including older schemas.
      select coalesce(jsonb_agg(jsonb_build_object('name',name) order by name),'[]') into headers from
        (select distinct m->>'name' name from jsonb_array_elements(h->'daily') v,
          jsonb_array_elements(v#>'{metadata,metricHeaders}') m) names;
      select jsonb_build_object('dimensionHeaders',jsonb_build_array(jsonb_build_object('name','date')),
        'metricHeaders',headers,'rows',coalesce(jsonb_agg(jsonb_build_object(
          'dimensionValues',v#>'{row,dimensionValues}', 'metricValues',(
            select jsonb_agg(coalesce((select v#>'{row,metricValues}'->(ord::int-1)
              from jsonb_array_elements(v#>'{metadata,metricHeaders}') with ordinality m(item,ord)
              where item->>'name'=header->>'name'),'{}') order by header->>'name')
            from jsonb_array_elements(headers) header)) order by v->>'date'),'[]')) into daily
        from jsonb_array_elements(h->'daily') v;
      -- Non-additive values are copied only from the exact-range aggregate.
      select jsonb_build_object('metricHeaders',coalesce(jsonb_agg(jsonb_build_object('name',name) order by name),'[]'),
        'rows',case when count(*)=0 then '[]'::jsonb else jsonb_build_array(jsonb_build_object('metricValues',
          jsonb_agg(jsonb_build_object('value',value::text) order by name))) end,
        'metadata',coalesce(s.data#>'{summary,metadata}','{}')) into totals from (
        select m->>'name' name,sum((v#>'{row,metricValues}'->(ord::int-1)->>'value')::numeric) value
        from jsonb_array_elements(h->'daily') v,
          jsonb_array_elements(v#>'{metadata,metricHeaders}') with ordinality x(m,ord)
        where m->>'name' in ('sessions','screenPageViews','keyEvents','totalRevenue') group by m->>'name'
        union all
        select m->>'name',(s.data#>'{summary,rows,0,metricValues}'->(ord::int-1)->>'value')::numeric
        from jsonb_array_elements(s.data#>'{summary,metricHeaders}') with ordinality x(m,ord)
        where m->>'name' not in ('sessions','screenPageViews','keyEvents','totalRevenue')
      ) metrics;
      doc := coalesce(doc,'{"pages":{},"channels":{},"devices":{},"events":{}}'::jsonb) || jsonb_build_object('summary',totals);
    end if;
    doc := doc || jsonb_build_object('daily',daily);
  end if;
  select * into j from public.google_report_jobs where website_id=w.id and fqdn=w.fqdn
    and kind=p_kind and property_id=p_property_id order by end_date desc,next_run_at limit 1;
  return jsonb_build_object('data', doc, 'sync', jsonb_build_object(
    'state', case when fetched is null then 'pending' when j.last_error is not null then 'error'
      when fetched < now() - case when j.kind in ('pagespeed','crux') then interval '26 hours' else interval '2 hours' end then 'stale' else 'ready' end,
    'fetched_at', fetched, 'coverage', h->'coverage', 'exact_range_available', s.id is not null,
    'observation_kind', case when p_kind='crux' then 'rolling_period' when p_kind='pagespeed' then 'lab_run' else null end, 'last_error', j.last_error,
    'next_run_at', j.next_run_at, 'cadence', case when j.kind in ('pagespeed','crux') then 'daily' else 'hourly' end,
    'connection_status', (select status from public.google_connections where owner_id = w.owner_id)));
end $$;
revoke all on function public.request_google_report(uuid,text,text,date,date) from public, anon;
grant execute on function public.request_google_report(uuid,text,text,date,date) to authenticated;

create or replace function public.request_bing_report(p_website_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w public.websites; j public.bing_report_jobs; s public.bing_report_snapshots;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous','true')='false';
  if not found then raise insufficient_privilege using message='Website not found'; end if;
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


-- Separate name avoids ambiguous PostgREST overloaded RPC resolution.
create function public.read_bing_history(p_website_id uuid,p_start_date date,p_end_date date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare saved jsonb; h jsonb; rows jsonb;
begin
  saved := public.request_bing_report(p_website_id);
  h := public.read_daily_history(p_website_id,'bing_traffic',coalesce(saved#>>'{data,site_url}',''),p_start_date,p_end_date);
  select coalesce(jsonb_agg((v->'row') || jsonb_build_object('Date',v->>'date') order by v->>'date'),'[]') into rows
    from jsonb_array_elements(h->'daily') v;
  if saved->'data' <> 'null'::jsonb then
    saved := jsonb_set(saved,'{data,sections}',coalesce(saved#>'{data,sections}','{}') ||
      jsonb_build_object('traffic',jsonb_build_object('rows',rows,'error',saved#>'{data,sections,traffic,error}')));
  end if;
  return jsonb_set(saved,'{sync,coverage}',h->'coverage');
end $$;
revoke all on function public.read_bing_history(uuid,date,date) from public,anon;
grant execute on function public.read_bing_history(uuid,date,date) to authenticated;

-- Keep raw history and expired job definitions; bound active recovery separately.
alter table public.google_report_jobs add column collection_class text not null default 'legacy'
  check (collection_class in ('legacy','current','recovery'));
alter table public.google_report_jobs add column recovery_generation uuid;
alter table public.google_report_jobs add column last_claimed_at timestamptz;

create function public.seed_history_recovery() returns void
language plpgsql security definer set search_path='' as $$
declare binding record; gap date; today date:=(now() at time zone 'UTC')::date;
begin
  -- At most one 28-day recovery job per website/source, three attempts per
  -- connection generation. Missing provider days cannot pin the cursor forever.
  for binding in
    select distinct j.website_id,j.fqdn,j.kind,j.property_id,c.generation
    from public.google_report_jobs j join public.websites w on w.id=j.website_id and w.fqdn=j.fqdn
    join public.google_connections c on c.owner_id=w.owner_id and c.status='connected'
    where j.collection_class='current' and j.refresh_until>now() and j.kind in ('analytics','conversions','search')
      and (j.kind='search' or j.property_id=w.ga4_property_id)
  loop
    if exists(select 1 from public.google_report_jobs j where j.website_id=binding.website_id and j.fqdn=binding.fqdn
      and j.kind=binding.kind and j.property_id=binding.property_id and j.collection_class='recovery'
      and j.refresh_until>now() and j.recovery_generation=binding.generation) then continue; end if;
    select max(today-i) into gap from generate_series(29,case when binding.kind='search' then 480 else 365 end) i
      where not exists(select 1 from public.provider_daily_history h where h.website_id=binding.website_id
        and h.fqdn=binding.fqdn and h.source=binding.kind and h.property_id=binding.property_id and h.day=today-i)
      and not exists(select 1 from public.google_report_jobs j where j.website_id=binding.website_id and j.fqdn=binding.fqdn
        and j.kind=binding.kind and j.property_id=binding.property_id and j.collection_class='recovery'
        and j.recovery_generation=binding.generation and today-i between j.start_date and j.end_date);
    if gap is not null then
      insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,refresh_until,collection_class,recovery_generation)
        values(binding.website_id,binding.fqdn,binding.kind,binding.property_id,
          greatest(gap-27,today-case when binding.kind='search' then 480 else 365 end),gap,now()+interval '7 days','recovery',binding.generation)
        on conflict(website_id,fqdn,kind,property_id,start_date,end_date) do update set
          collection_class='recovery',recovery_generation=excluded.recovery_generation,refresh_until=excluded.refresh_until,
          next_run_at=now(),failures=0,last_error=null,lease=null,leased_until=null;
    end if;
  end loop;
end $$;
revoke all on function public.seed_history_recovery() from public,anon,authenticated;
grant execute on function public.seed_history_recovery() to service_role;

-- Finish recovery after success or three failures; no snapshot deletion.
create function public.finish_history_recovery() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.collection_class='recovery' and old.lease is not null and new.lease is null
    and (new.failures=0 or new.failures>=3) then new.refresh_until:=now(); end if;
  return new;
end $$;
revoke all on function public.finish_history_recovery() from public,anon,authenticated;
create trigger finish_history_recovery before update on public.google_report_jobs
  for each row execute function public.finish_history_recovery();
create or replace function public.claim_google_report() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.google_report_jobs; v_website public.websites; v_connection public.google_connections;
begin
  if not pg_try_advisory_xact_lock(320032) then return null; end if;
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
    where c.status='connected' and (k.kind <> 'business_locations' or (public.business_profile_enabled() and 'https://www.googleapis.com/auth/business.manage'=any(c.scopes)))
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
    where c.status='connected' and public.business_profile_enabled() and 'https://www.googleapis.com/auth/business.manage'=any(c.scopes)
    on conflict (website_id,fqdn,kind,property_id,start_date,end_date) do update set refresh_until=excluded.refresh_until;
  -- Old user-selected windows are retained but never refreshed. Only scheduled
  -- current windows and bounded recovery work can consume collector capacity.
  update public.google_report_jobs set collection_class='current'
    where (start_date=date '1970-01-01' and end_date=date '1970-01-01')
      or (start_date=(now() at time zone 'UTC')::date-28 and end_date=(now() at time zone 'UTC')::date-1);
  update public.google_report_jobs set refresh_until=now()
    where collection_class='legacy' or (collection_class='current' and end_date<>date '1970-01-01'
      and end_date<(now() at time zone 'UTC')::date-1);
  perform public.seed_history_recovery();
  select q.* into j from public.google_report_jobs q
    join public.websites w on w.id=q.website_id and w.fqdn=q.fqdn
    join public.google_connections c on c.owner_id=w.owner_id and c.status='connected'
    where q.next_run_at <= now() and q.refresh_until > now()
      and (q.kind not like 'business_%' or public.business_profile_enabled())
      and (q.leased_until is null or q.leased_until < now())
      and (q.kind not in ('analytics','conversions') or q.property_id=w.ga4_property_id)
      and (q.kind not in ('business_profile','business_performance') or exists
        (select 1 from public.website_business_locations b where b.website_id=w.id and b.fqdn=w.fqdn and b.location_id=q.property_id))
      and case when q.kind in ('analytics','conversions') then 'https://www.googleapis.com/auth/analytics.readonly'=any(c.scopes)
        when q.kind in ('pagespeed','crux') then true
        when q.kind like 'business_%' then 'https://www.googleapis.com/auth/business.manage'=any(c.scopes)
        else 'https://www.googleapis.com/auth/webmasters.readonly'=any(c.scopes) end
    order by (select max(x.last_claimed_at) from public.google_report_jobs x where x.website_id=q.website_id) nulls first,
      case when q.collection_class='current' then 0 else 1 end,q.next_run_at,q.id for update of q skip locked limit 1;
  if not found then return null; end if;
  update public.google_report_jobs set last_claimed_at=clock_timestamp(),lease=gen_random_uuid(),leased_until=now()+interval '3 minutes'
    where id=j.id returning * into j;
  select * into v_website from public.websites where id=j.website_id;
  select * into v_connection from public.google_connections where owner_id=v_website.owner_id;
  return to_jsonb(j) || jsonb_build_object('owner_id',v_website.owner_id,'generation',v_connection.generation,'encrypted_grant',v_connection.encrypted_grant);
end $$;
revoke all on function public.claim_google_report() from public,anon,authenticated;
grant execute on function public.claim_google_report() to service_role;


