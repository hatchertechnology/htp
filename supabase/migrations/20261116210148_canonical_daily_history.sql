-- Additive foundation only: existing report RPCs are not switched here.
-- Never infer a zero day from an omitted row or split a rolling period into days.
create table public.provider_daily_history (
  website_id uuid not null references public.websites(id) on delete cascade,
  fqdn text not null,
  source text not null check (source in ('analytics','conversions','search','bing_traffic')),
  property_id text not null,
  day date not null,
  row_data jsonb not null check (jsonb_typeof(row_data)='object'),
  metadata jsonb not null check (jsonb_typeof(metadata)='object'),
  fetched_at timestamptz not null,
  google_snapshot_id bigint references public.google_report_snapshots(id) on delete cascade,
  bing_snapshot_id bigint references public.bing_report_snapshots(id) on delete cascade,
  check ((source='bing_traffic' and bing_snapshot_id is not null and google_snapshot_id is null)
    or (source<>'bing_traffic' and google_snapshot_id is not null and bing_snapshot_id is null)),
  primary key (website_id,fqdn,source,property_id,day)
);
alter table public.provider_daily_history enable row level security;
revoke all on public.provider_daily_history from public,anon,authenticated;
grant all on public.provider_daily_history to service_role;

-- Invalid legacy dates are quarantined in retained raw snapshots, not guessed.
create function public.history_day(p_value text, p_bing boolean default false) returns date
language plpgsql immutable set search_path='' as $$
declare v text; d date; m text[]; minutes integer;
begin
  if p_bing and p_value ~ '^/Date\(-?[0-9]+([+-][0-9]{4})?\)/$' then
    m := regexp_match(p_value, '^/Date\((-?[0-9]+)([+-][0-9]{4})?\)/$');
    minutes := case when m[2] is null then 0 else
      (substring(m[2],2,2)::integer*60+substring(m[2],4,2)::integer)
        * case when left(m[2],1)='-' then -1 else 1 end end;
    if abs(minutes)>14*60 or (m[2] is not null and substring(m[2],4,2)::integer>=60) then return null; end if;
    return (to_timestamp(m[1]::double precision/1000) at time zone 'UTC' + make_interval(mins=>minutes))::date;
  end if;
  v := case when p_value ~ '^[0-9]{8}$' then
    substring(p_value,1,4)||'-'||substring(p_value,5,2)||'-'||substring(p_value,7,2)
    else p_value end;
  if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  d := v::date;
  if to_char(d,'YYYY-MM-DD') <> v then return null; end if;
  return d;
exception when datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then return null;
end $$;
revoke all on function public.history_day(text,boolean) from public,anon,authenticated;
grant execute on function public.history_day(text,boolean) to service_role;

-- Entire daily observation is replaced, never individual metrics from different
-- revisions. fetched_at + snapshot id makes backfill/live ingestion order irrelevant.
create function public.normalize_history_snapshot(p_provider text,p_snapshot_id bigint) returns integer
language plpgsql security definer set search_path='' as $$
declare doc jsonb; meta jsonb; rows jsonb; r jsonb; d date; source_name text;
  website uuid; host text; property text; fetched timestamptz; range_start date; range_end date;
  inserted integer := 0; affected integer;
begin
  if p_provider='google' then
    select s.data,j.website_id,j.fqdn,j.property_id,j.kind,s.fetched_at,j.start_date,j.end_date
      into doc,website,host,property,source_name,fetched,range_start,range_end
      from public.google_report_snapshots s join public.google_report_jobs j on j.id=s.job_id where s.id=p_snapshot_id;
    if not found or source_name not in ('analytics','conversions','search') then return 0; end if;
    rows := doc#>'{daily,rows}';
    meta := coalesce(doc->'daily','{}'::jsonb)-'rows';
    if source_name in ('analytics','conversions') and
      (doc#>>'{daily,dimensionHeaders,0,name}' is distinct from 'date'
       or jsonb_typeof(doc#>'{daily,metricHeaders}') is distinct from 'array') then return 0; end if;
  elsif p_provider='bing' then
    select s.data,j.website_id,j.fqdn,s.data->>'site_url',s.fetched_at
      into doc,website,host,property,fetched
      from public.bing_report_snapshots s join public.bing_report_jobs j on j.id=s.job_id where s.id=p_snapshot_id;
    if not found or property is null or doc#>>'{sections,traffic,error}' is not null then return 0; end if;
    source_name := 'bing_traffic'; rows := doc#>'{sections,traffic,rows}'; meta := '{}'::jsonb;
  else raise invalid_parameter_value using message='Invalid history provider'; end if;
  if jsonb_typeof(rows) is distinct from 'array' or jsonb_typeof(meta) is distinct from 'object' then return 0; end if;
  for r in select value from jsonb_array_elements(rows) loop
    d := public.history_day(case when source_name='bing_traffic' then r->>'Date'
      when source_name='search' then r#>>'{keys,0}' else r#>>'{dimensionValues,0,value}' end,source_name='bing_traffic');
    if d is null or jsonb_typeof(r)<>'object' or (p_provider='google' and (d<range_start or d>range_end)) then continue; end if;
    -- Coverage requires a valid observed row, not just a parseable date.
    if source_name in ('analytics','conversions') then
      if jsonb_typeof(r->'metricValues') is distinct from 'array' then continue; end if;
      if jsonb_array_length(r->'metricValues')<>jsonb_array_length(meta->'metricHeaders')
        or jsonb_array_length(meta->'metricHeaders')=0
        or exists (select 1 from jsonb_array_elements(r->'metricValues') v
          where coalesce(v->>'value','') !~ '^-?[0-9]+([.][0-9]+)?$') then continue; end if;
    elsif source_name='search' then
      if jsonb_typeof(r->'clicks') is distinct from 'number'
        or jsonb_typeof(r->'impressions') is distinct from 'number' then continue; end if;
    elsif jsonb_typeof(r->'Clicks') is distinct from 'number'
      or jsonb_typeof(r->'Impressions') is distinct from 'number' then continue;
    end if;
    insert into public.provider_daily_history as h
      (website_id,fqdn,source,property_id,day,row_data,metadata,fetched_at,google_snapshot_id,bing_snapshot_id)
      values(website,host,source_name,property,d,r,meta,fetched,
        case when p_provider='google' then p_snapshot_id end,case when p_provider='bing' then p_snapshot_id end)
      on conflict (website_id,fqdn,source,property_id,day) do update set
        row_data=excluded.row_data,metadata=excluded.metadata,fetched_at=excluded.fetched_at,
        google_snapshot_id=excluded.google_snapshot_id,bing_snapshot_id=excluded.bing_snapshot_id
      where (excluded.fetched_at,coalesce(excluded.google_snapshot_id,excluded.bing_snapshot_id))
        > (h.fetched_at,coalesce(h.google_snapshot_id,h.bing_snapshot_id));
    get diagnostics affected = row_count; inserted := inserted+affected;
  end loop;
  return inserted;
end $$;
revoke all on function public.normalize_history_snapshot(text,bigint) from public,anon,authenticated;
grant execute on function public.normalize_history_snapshot(text,bigint) to service_role;

create function public.capture_daily_history() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform public.normalize_history_snapshot(TG_ARGV[0],new.id);
  return new;
end $$;
revoke all on function public.capture_daily_history() from public,anon,authenticated;
create trigger google_daily_history after insert on public.google_report_snapshots
  for each row execute function public.capture_daily_history('google');
create trigger bing_daily_history after insert on public.bing_report_snapshots
  for each row execute function public.capture_daily_history('bing');

-- Explicit service operation, not run by the migration or by report readers.
-- Save next_cursor between batches; replaying any batch is safe.
create function public.backfill_daily_history(p_provider text,p_after_id bigint default 0,p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s record; cursor_id bigint:=p_after_id; processed integer:=0; changed integer:=0;
begin
  if p_provider is null or p_provider not in ('google','bing') or p_after_id is null or p_after_id<0
    or p_limit is null or p_limit<1 or p_limit>500 then
    raise invalid_parameter_value using message='Invalid history backfill batch';
  end if;
  for s in select id from (
      select id from public.google_report_snapshots where p_provider='google' and id>p_after_id
      union all select id from public.bing_report_snapshots where p_provider='bing' and id>p_after_id
    ) snapshots order by id limit p_limit loop
    changed := changed+public.normalize_history_snapshot(p_provider,s.id);
    processed := processed+1; cursor_id:=s.id;
  end loop;
  return jsonb_build_object('next_cursor',cursor_id,'processed',processed,'changed',changed);
end $$;
revoke all on function public.backfill_daily_history(text,bigint,integer) from public,anon,authenticated;
grant execute on function public.backfill_daily_history(text,bigint,integer) to service_role;

-- A side-effect-free primitive for read cutover. It neither requires an active
-- connection nor creates/refreshes collection jobs. Missing days remain unknown.
create function public.read_daily_history(p_website_id uuid,p_source text,p_property_id text,p_start_date date,p_end_date date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w public.websites; observations jsonb; missing jsonb; n integer;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous','true')='false';
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  if p_source is null or p_source not in ('analytics','conversions','search','bing_traffic') or p_property_id is null
    or length(p_property_id)>2048 or p_start_date is null or p_end_date is null
    or p_end_date<p_start_date or p_end_date-p_start_date>=366 then
    raise invalid_parameter_value using message='Invalid history range';
  end if;
  if p_source in ('analytics','conversions') and p_property_id is distinct from w.ga4_property_id then
    raise invalid_parameter_value using message='Save the website GA4 property first'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('date',day,'row',row_data,'metadata',metadata,
    'fetched_at',fetched_at,'snapshot_id',coalesce(google_snapshot_id,bing_snapshot_id)) order by day),'[]'::jsonb),count(*)
    into observations,n from public.provider_daily_history
    where website_id=w.id and fqdn=w.fqdn and source=p_source and property_id=p_property_id and day between p_start_date and p_end_date;
  select coalesce(jsonb_agg(to_char(p_start_date+i,'YYYY-MM-DD') order by i),'[]'::jsonb) into missing
    from generate_series(0,p_end_date-p_start_date) i where not exists
    (select 1 from public.provider_daily_history where website_id=w.id and fqdn=w.fqdn and source=p_source
      and property_id=p_property_id and day=p_start_date+i);
  return jsonb_build_object('source',p_source,'property_id',p_property_id,'start_date',p_start_date,'end_date',p_end_date,
    'daily',observations,'coverage',jsonb_build_object('state',case when n=0 then 'unavailable'
      when n=p_end_date-p_start_date+1 then 'complete' else 'partial' end,'observed_days',n,'missing_dates',missing));
end $$;
revoke all on function public.read_daily_history(uuid,text,text,date,date) from public,anon;
grant execute on function public.read_daily_history(uuid,text,text,date,date) to authenticated;
