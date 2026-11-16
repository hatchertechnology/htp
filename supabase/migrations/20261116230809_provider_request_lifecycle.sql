-- Keyed caller intents are separate from the shared provider job and its legacy
-- explicit deadline. Website-row locks serialize creation and withdrawal.
create table public.provider_report_requests (
  website_id uuid not null references public.websites(id) on delete cascade,
  request_key text not null check (request_key ~ '^[A-Za-z0-9._~-]{1,128}$'),
  fqdn text not null, kind text not null, property_id text not null,
  start_date date, end_date date, association_start date, association_end date,
  job_id uuid not null, expires_at timestamptz not null,
  withdrawn_at timestamptz,
  primary key (website_id,request_key)
);
alter table public.provider_report_requests enable row level security;
revoke all on public.provider_report_requests from public,anon,authenticated;
grant all on public.provider_report_requests to service_role;
alter table public.google_report_jobs add column keyed_until timestamptz;

create function public.provider_report_request_value(r public.provider_report_requests) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('requestKey',r.request_key,
    'status',case when r.withdrawn_at is not null then 'withdrawn' when r.expires_at<=now() then 'expired' else 'accepted' end,
    'expiresAt',r.expires_at,
    'association',jsonb_build_object('provider',case when r.kind='bing' then 'bing' else 'google' end,
      'kind',r.kind,'fqdn',r.fqdn,'propertyId',case when r.kind='bing' then null else r.property_id end,
      'startDate',case when r.kind='bing' then null else r.association_start end,
      'endDate',case when r.kind='bing' then null else r.association_end end));
$$;
revoke all on function public.provider_report_request_value(public.provider_report_requests) from public,anon,authenticated;

create function public.get_provider_report_request(p_website_id uuid,p_request_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.provider_report_requests;
begin
  if not exists(select 1 from public.websites where id=p_website_id and owner_id=auth.uid() and coalesce(auth.jwt()->>'is_anonymous','true')='false') then
    return jsonb_build_object('code','NOT_FOUND'); end if;
  if p_request_key is null or p_request_key !~ '^[A-Za-z0-9._~-]{1,128}$' then return jsonb_build_object('code','INVALID_ARGUMENT'); end if;
  select * into r from public.provider_report_requests where website_id=p_website_id and request_key=p_request_key;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  return jsonb_build_object('collection',public.provider_report_request_value(r));
end $$;

create function public.cancel_provider_report_request(p_website_id uuid,p_request_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.provider_report_requests; deadline timestamptz;
begin
  perform 1 from public.websites where id=p_website_id and owner_id=auth.uid() and coalesce(auth.jwt()->>'is_anonymous','true')='false' for no key update;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  perform pg_advisory_xact_lock(320032);
  if p_request_key is null or p_request_key !~ '^[A-Za-z0-9._~-]{1,128}$' then return jsonb_build_object('code','INVALID_ARGUMENT'); end if;
  select * into r from public.provider_report_requests where website_id=p_website_id and request_key=p_request_key for update;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  if r.withdrawn_at is null and r.expires_at>now() then
    update public.provider_report_requests set withdrawn_at=now() where website_id=p_website_id and request_key=p_request_key returning * into r;
    if r.kind<>'bing' then
      select max(expires_at) into deadline from public.provider_report_requests where job_id=r.job_id and kind<>'bing' and withdrawn_at is null and expires_at>now();
      update public.google_report_jobs set keyed_until=deadline where id=r.job_id;
    end if;
  end if;
  return jsonb_build_object('collection',public.provider_report_request_value(r));
end $$;

create function public.register_provider_report_request(p_website_id uuid,p_request_key text,p_kind text,p_property_id text,p_start_date date,p_end_date date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.websites; r public.provider_report_requests; oldjob public.google_report_jobs; j public.google_report_jobs; bid uuid; s date:=p_start_date; e date:=p_end_date; prop text:=case when p_kind in ('properties','bing') then '' else coalesce(p_property_id,'') end;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid() and coalesce(auth.jwt()->>'is_anonymous','true')='false' for no key update;
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  perform pg_advisory_xact_lock(320032);
  if p_request_key is null or p_request_key !~ '^[A-Za-z0-9._~-]{1,128}$' then return jsonb_build_object('code','INVALID_ARGUMENT'); end if;
  select * into r from public.provider_report_requests where website_id=w.id and request_key=p_request_key;
  if found then
    if r.kind is distinct from p_kind or r.property_id is distinct from prop or r.start_date is distinct from s or r.end_date is distinct from e then
      return jsonb_build_object('code','CONFLICT'); end if;
    return jsonb_build_object('collection',public.provider_report_request_value(r));
  end if;
  if (select count(*) from public.provider_report_requests where website_id=w.id)>=1000
    or (select count(*) from public.provider_report_requests where website_id=w.id and withdrawn_at is null and expires_at>now())>=100 then
    return jsonb_build_object('code','LIMIT_EXCEEDED'); end if;
  if p_kind='bing' and ((p_start_date is null)<>(p_end_date is null) or (p_start_date is not null and (p_start_date<date '2000-01-01' or p_end_date<p_start_date or p_end_date-p_start_date>365))) then
    return jsonb_build_object('code','INVALID_ARGUMENT'); end if;
  if p_kind in ('properties','pagespeed','crux','business_locations','business_profile') and ((p_start_date is null)<>(p_end_date is null) or (p_start_date is not null and (p_end_date<p_start_date or p_end_date-p_start_date>365))) then
    return jsonb_build_object('code','INVALID_ARGUMENT'); end if;
  if p_kind not in ('bing','properties','pagespeed','crux','business_locations','business_profile') and (p_start_date is null or p_end_date is null or p_end_date<p_start_date or p_end_date-p_start_date>365) then
    return jsonb_build_object('code','INVALID_ARGUMENT'); end if;
  if p_kind in ('properties','pagespeed','crux','business_locations','business_profile') then s:=date '1970-01-01'; e:=s; end if;
  if p_kind<>'bing' then
    select * into oldjob from public.google_report_jobs where website_id=w.id and fqdn=w.fqdn and kind=p_kind and property_id=prop and start_date=s and end_date=e for update;
  end if;
  perform public.register_report_collection(w.id,p_kind,prop,coalesce(s,date '1970-01-01'),coalesce(e,date '1970-01-01'));
  if p_kind='bing' then
    select id into bid from public.bing_report_jobs where website_id=w.id and fqdn=w.fqdn;
  else
    select * into j from public.google_report_jobs where website_id=w.id and fqdn=w.fqdn and kind=p_kind and property_id=prop and start_date=s and end_date=e for update;
    bid:=j.id;
    update public.google_report_jobs set explicit_until=oldjob.explicit_until,
      refresh_until=coalesce(oldjob.refresh_until,now()),
      collection_class=coalesce(oldjob.collection_class,'explicit'),
      keyed_until=greatest(coalesce(oldjob.keyed_until,'-infinity'::timestamptz),now()+interval '7 days') where id=j.id;
  end if;
  insert into public.provider_report_requests(website_id,request_key,fqdn,kind,property_id,start_date,end_date,association_start,association_end,job_id,expires_at)
    values(w.id,p_request_key,w.fqdn,p_kind,prop,p_start_date,p_end_date,s,e,bid,now()+interval '7 days') returning * into r;
  return jsonb_build_object('collection',public.provider_report_request_value(r));
exception when program_limit_exceeded then return jsonb_build_object('code','LIMIT_EXCEEDED');
  when invalid_parameter_value then return jsonb_build_object('code','INVALID_ARGUMENT');
end $$;
revoke all on function public.get_provider_report_request(uuid,text),public.cancel_provider_report_request(uuid,text),public.register_provider_report_request(uuid,text,text,text,date,date) from public,anon;
grant execute on function public.get_provider_report_request(uuid,text),public.cancel_provider_report_request(uuid,text),public.register_provider_report_request(uuid,text,text,text,date,date) to authenticated;

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
  -- Discovery is stored independently of viewing. Schedule every displayed
  -- property (bounded to 50) on each rolling date, including URL prefixes.
  insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,refresh_until)
    select w.id,w.fqdn,'search',entry->>'siteUrl',(now() at time zone 'UTC')::date-28,
      (now() at time zone 'UTC')::date-1,now()+interval '7 days'
    from public.websites w join public.google_connections c on c.owner_id=w.owner_id and c.status='connected'
    join lateral (select s.data from public.google_report_jobs discovery_job join public.google_report_snapshots s on s.job_id=discovery_job.id
      where discovery_job.website_id=w.id and discovery_job.fqdn=w.fqdn and discovery_job.kind='properties'
      order by s.fetched_at desc,s.id desc limit 1) discovery on true
    cross join lateral (select value entry from jsonb_array_elements(case when jsonb_typeof(discovery.data->'properties')='array'
      then discovery.data->'properties' else '[]'::jsonb end) limit 50) properties
    where 'https://www.googleapis.com/auth/webmasters.readonly'=any(c.scopes)
      and entry->>'siteUrl' is not null and length(entry->>'siteUrl')<=2048
    on conflict (website_id,fqdn,kind,property_id,start_date,end_date) do update set refresh_until=excluded.refresh_until;
  -- Old user-selected windows are retained but never refreshed. Only scheduled
  -- current windows and bounded recovery work can consume collector capacity.
  update public.google_report_jobs set collection_class='current'
    where (start_date=date '1970-01-01' and end_date=date '1970-01-01')
      or (start_date=(now() at time zone 'UTC')::date-28 and end_date=(now() at time zone 'UTC')::date-1);
  -- An explicit subscription can overlap a rolling job. Keep its independent
  -- deadline when the rolling range ages out, including before its first claim.
  update public.google_report_jobs set collection_class='explicit',
    refresh_until=greatest(refresh_until,explicit_until,keyed_until)
    where collection_class='current' and end_date<>date '1970-01-01'
      and end_date<(now() at time zone 'UTC')::date-1 and greatest(coalesce(explicit_until,'-infinity'::timestamptz),coalesce(keyed_until,'-infinity'::timestamptz))>now();
  update public.google_report_jobs set refresh_until=now()
    where (collection_class='legacy' and greatest(coalesce(explicit_until,'-infinity'::timestamptz),coalesce(keyed_until,'-infinity'::timestamptz))<=now())
      or (collection_class='current' and end_date<>date '1970-01-01'
      and end_date<(now() at time zone 'UTC')::date-1 and greatest(coalesce(explicit_until,'-infinity'::timestamptz),coalesce(keyed_until,'-infinity'::timestamptz))<=now());
  perform public.seed_history_recovery();
  select q.* into j from public.google_report_jobs q
    join public.websites w on w.id=q.website_id and w.fqdn=q.fqdn
    join public.google_connections c on c.owner_id=w.owner_id and c.status='connected'
    where q.next_run_at <= now() and (q.refresh_until > now() or q.keyed_until > now())
      and (q.collection_class <> 'explicit' or greatest(coalesce(q.explicit_until,'-infinity'::timestamptz),coalesce(q.keyed_until,'-infinity'::timestamptz))>now())
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
      coalesce((select max(x.last_claimed_at) from public.google_report_jobs x
        where x.website_id=q.website_id and x.collection_class=q.collection_class),'-infinity'::timestamptz),
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

-- Count keyed work in the existing range and sampled URL limits.
create or replace function public.register_report_collection(p_website_id uuid,p_kind text,p_property_id text,p_start_date date,p_end_date date) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.websites; target text; existing public.google_report_jobs;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous','true')='false' for no key update;
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  if p_kind='bing' then
    insert into public.bing_report_jobs(website_id,fqdn) values(w.id,w.fqdn) on conflict(website_id,fqdn) do nothing;
    return jsonb_build_object('collectionRegistered',true);
  end if;
  -- Reuse the independent read's source, owner, feature gate and date checks.
  perform public.request_google_report(p_website_id,p_kind,p_property_id,p_start_date,p_end_date);
  -- This RPC is directly callable by authenticated clients; do not rely on
  -- the HTTP handler or eventual worker to reject foreign Search properties.
  if p_kind='search' and not (
    (p_property_id ~ '^sc-domain:[a-z0-9][a-z0-9.-]*$' and strpos(substr(p_property_id,11),'.')>0
      and (substr(p_property_id,11)=w.fqdn or right(w.fqdn,length(substr(p_property_id,11))+1)='.'||substr(p_property_id,11)))
    or ((starts_with(p_property_id,'https://'||w.fqdn||'/') or starts_with(p_property_id,'http://'||w.fqdn||'/'))
      and right(p_property_id,1)='/' and p_property_id !~ '[[:space:]?#]' and strpos(p_property_id,chr(92))=0)
  ) then raise invalid_parameter_value using message='Invalid Search property'; end if;
  if p_kind in ('pagespeed','crux','business_locations','business_profile') then
    p_start_date:=date '1970-01-01'; p_end_date:=date '1970-01-01';
  end if;
  if p_kind in ('pagespeed','crux') and strpos(p_property_id,'|')>0 then
    target:=substr(p_property_id,strpos(p_property_id,'|')+1);
    if not exists(select 1 from public.google_report_jobs j where j.website_id=w.id and j.fqdn=w.fqdn
      and j.kind in ('pagespeed','crux') and (j.refresh_until>now() or j.keyed_until>now()) and strpos(j.property_id,'|')>0
      and substr(j.property_id,strpos(j.property_id,'|')+1)=target)
      and (select count(distinct substr(j.property_id,strpos(j.property_id,'|')+1)) from public.google_report_jobs j
      where j.website_id=w.id and j.fqdn=w.fqdn and j.kind in ('pagespeed','crux')
      and (j.refresh_until>now() or j.keyed_until>now()) and strpos(j.property_id,'|')>0)>=10 then
      raise program_limit_exceeded using message='At most ten active sampled URLs per website'; end if;
  end if;
  select * into existing from public.google_report_jobs j where j.website_id=w.id and j.fqdn=w.fqdn
    and j.kind=p_kind and j.property_id=p_property_id and j.start_date=p_start_date and j.end_date=p_end_date;
  if (not found or (existing.refresh_until<=now() and coalesce(existing.keyed_until,'-infinity'::timestamptz)<=now())) and (select count(*) from public.google_report_jobs j where j.website_id=w.id and (j.refresh_until>now() or j.keyed_until>now()))>=100 then
    raise program_limit_exceeded using message='Too many active report ranges'; end if;
  insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,refresh_until,collection_class,explicit_until)
    values(w.id,w.fqdn,p_kind,p_property_id,p_start_date,p_end_date,now()+interval '7 days','explicit',now()+interval '7 days')
    on conflict(website_id,fqdn,kind,property_id,start_date,end_date) do update
      set refresh_until=greatest(public.google_report_jobs.refresh_until,excluded.refresh_until),
        explicit_until=greatest(coalesce(public.google_report_jobs.explicit_until,'-infinity'::timestamptz),excluded.explicit_until),
        collection_class=case when public.google_report_jobs.collection_class='current' then 'current' else 'explicit' end;
  return jsonb_build_object('collectionRegistered',true);
end $$;
revoke all on function public.register_report_collection(uuid,text,text,date,date) from public,anon;
grant execute on function public.register_report_collection(uuid,text,text,date,date) to authenticated;
