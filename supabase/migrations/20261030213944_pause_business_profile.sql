-- Reversible pause while Google Basic API Access is pending: issue #2.
-- Existing jobs, linked locations, observations and change history are retained.
create or replace function public.business_profile_enabled() returns boolean
language sql immutable set search_path = '' as $$ select false $$;
revoke all on function public.business_profile_enabled() from public,anon,authenticated;
grant execute on function public.business_profile_enabled() to service_role;

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
  if p_kind like 'business_%' and not public.business_profile_enabled() then
    raise object_not_in_prerequisite_state using message = 'Business Profile integration is temporarily disabled';
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


create or replace function public.set_business_location(p_website_id uuid,p_location_id text,p_linked boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.websites; discovery jsonb;
begin
  if not public.business_profile_enabled() then
    raise object_not_in_prerequisite_state using message = 'Business Profile integration is temporarily disabled';
  end if;
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
