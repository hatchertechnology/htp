-- Lease-validated completion paths are the authoritative operational source.
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
  perform public.audit_operational_completion(w.id,j.fqdn,'google',j.id,
    case when p_error is null and p_data is not null then 'recovered' else 'failed' end,
    case when p_error is null and p_data is not null then null when p_error='google_authorization_required' then 'authentication_required' when p_error='google_quota_exceeded' then 'rate_limited' when p_error in ('google_unavailable','integration_not_configured') or p_error is null then 'provider_unavailable' else 'other' end);
  return true;
end $$;

create or replace function public.complete_bing_report(p_job_id uuid,p_lease uuid,p_generation uuid,p_data jsonb default null,p_error text default null) returns boolean
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
  perform public.audit_operational_completion(w.id,j.fqdn,'bing',j.id,
    case when p_error is null and p_data is not null then 'recovered' else 'failed' end,
    case when p_error is null and p_data is not null then null when p_error='bing_authorization_required' then 'authentication_required' when p_error='bing_quota_exceeded' then 'rate_limited' when p_error='bing_unavailable' or p_error is null then 'provider_unavailable' else 'other' end);
  return true;
end $$;

create or replace function public.complete_website_repository(p_id uuid,p_lease uuid,p_commits jsonb,p_scan_ref text,p_done boolean,p_error text default null,p_retry_seconds integer default 3600) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.website_repositories; w public.websites;
begin
  -- Lock the website first, matching edit/rename order and preventing late writes.
  select w0.* into w from public.websites w0 join public.website_repositories b on b.website_id=w0.id where b.id=p_id for no key update of w0;
  select * into r from public.website_repositories where id=p_id for update;
  if p_lease is null or r.lease is null or r.id is null or not r.enabled or r.fqdn<>w.fqdn or r.lease is distinct from p_lease or r.leased_until<now() then return false; end if;
  if p_error is null then
    if jsonb_typeof(p_commits)<>'array' or jsonb_array_length(p_commits)>100 or p_done is null or (p_scan_ref is not null and p_scan_ref !~ '^[0-9a-f]{40,64}$') then raise invalid_parameter_value; end if;
    insert into public.website_repository_commits(repository_id,sha,message,author,authored_at,committed_at)
      select r.id,x.sha,left(x.message,20000),left(x.author,256),x.authored_at,x.committed_at
      from jsonb_to_recordset(p_commits) as x(sha text,message text,author text,authored_at timestamptz,committed_at timestamptz)
      on conflict(repository_id,sha) do nothing;
    update public.website_repositories set
      head_sha=case when p_done then coalesce(p_scan_ref,head_sha) else head_sha end,
      scan_ref=case when p_done then null else p_scan_ref end,scan_page=case when p_done then 1 else scan_page+1 end,
      last_checked_at=now(),last_error=null,next_run_at=now()+case when p_done then interval '1 hour' else interval '1 minute' end,
      lease=null,leased_until=null where id=r.id;
  else
    update public.website_repositories set last_checked_at=now(),last_error=left(p_error,100),
      next_run_at=now()+make_interval(secs=>greatest(60,least(p_retry_seconds,86400))),lease=null,leased_until=null where id=r.id;
  end if;
  perform public.audit_operational_completion(w.id,r.fqdn,'repository',r.id,
    case when p_error is null then 'recovered' else 'failed' end,
    case when p_error is null then null else 'other' end);
  return true;
end $$;
