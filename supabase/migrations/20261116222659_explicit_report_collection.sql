-- Explicit collection is separate from dashboard reads. Existing legacy ranges
-- remain retired; only this owner-checked action can create explicit work.
alter table public.google_report_jobs drop constraint google_report_jobs_collection_class_check;
alter table public.google_report_jobs add constraint google_report_jobs_collection_class_check
  check (collection_class in ('legacy','current','recovery','explicit'));

create function public.register_report_collection(p_website_id uuid,p_kind text,p_property_id text,p_start_date date,p_end_date date) returns jsonb
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
  if p_kind in ('pagespeed','crux','business_locations','business_profile') then
    p_start_date:=date '1970-01-01'; p_end_date:=date '1970-01-01';
  end if;
  if p_kind in ('pagespeed','crux') and strpos(p_property_id,'|')>0 then
    target:=substr(p_property_id,strpos(p_property_id,'|')+1);
    if not exists(select 1 from public.google_report_jobs j where j.website_id=w.id and j.fqdn=w.fqdn
      and j.kind in ('pagespeed','crux') and j.refresh_until>now() and strpos(j.property_id,'|')>0
      and substr(j.property_id,strpos(j.property_id,'|')+1)=target)
      and (select count(distinct substr(j.property_id,strpos(j.property_id,'|')+1)) from public.google_report_jobs j
      where j.website_id=w.id and j.fqdn=w.fqdn and j.kind in ('pagespeed','crux')
      and j.refresh_until>now() and strpos(j.property_id,'|')>0)>=10 then
      raise program_limit_exceeded using message='At most ten active sampled URLs per website'; end if;
  end if;
  select * into existing from public.google_report_jobs j where j.website_id=w.id and j.fqdn=w.fqdn
    and j.kind=p_kind and j.property_id=p_property_id and j.start_date=p_start_date and j.end_date=p_end_date;
  if not found and (select count(*) from public.google_report_jobs j where j.website_id=w.id and j.refresh_until>now())>=100 then
    raise program_limit_exceeded using message='Too many active report ranges'; end if;
  insert into public.google_report_jobs(website_id,fqdn,kind,property_id,start_date,end_date,refresh_until,collection_class)
    values(w.id,w.fqdn,p_kind,p_property_id,p_start_date,p_end_date,now()+interval '7 days','explicit')
    on conflict(website_id,fqdn,kind,property_id,start_date,end_date) do update
      set refresh_until=greatest(public.google_report_jobs.refresh_until,excluded.refresh_until),
        collection_class=case when public.google_report_jobs.collection_class='current' then 'current' else 'explicit' end;
  return jsonb_build_object('collectionRegistered',true);
end $$;
revoke all on function public.register_report_collection(uuid,text,text,date,date) from public,anon;
grant execute on function public.register_report_collection(uuid,text,text,date,date) to authenticated;
