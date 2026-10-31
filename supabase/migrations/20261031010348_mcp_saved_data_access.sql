-- Read-only boundary for agent research. Provider tables remain service-only;
-- deliberately expose saved evidence, never OAuth grants or worker lease tokens.
create function public.website_saved_data(
  p_fqdn text, p_dataset text, p_job_id uuid default null,
  p_before_id text default null, p_limit integer default 20
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare w public.websites; items jsonb; result jsonb; more boolean;
  job_cursor uuid; row_cursor bigint;
begin
  select * into w from public.websites where fqdn=p_fqdn and owner_id=auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous','true')='false';
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  if p_dataset is null or p_dataset not in ('sources','snapshots','profile_changes')
    or p_limit is null or p_limit<1 or p_limit>100 then
    raise invalid_parameter_value using message='Invalid dataset or limit'; end if;
  if p_job_id is not null and not exists(select 1 from public.google_report_jobs
    where id=p_job_id and website_id=w.id and fqdn=w.fqdn) then
    raise invalid_parameter_value using message='Invalid source'; end if;
  if p_before_id is not null then
    begin
      if p_dataset='sources' then job_cursor:=p_before_id::uuid;
      else row_cursor:=p_before_id::bigint;
        if row_cursor<=0 then raise invalid_parameter_value; end if;
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
      raise invalid_parameter_value using message='Invalid cursor';
    end;
  end if;
  if p_dataset='sources' then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc),'[]'::jsonb) into items from (
      select j.id,j.fqdn,j.kind,j.property_id,j.start_date,j.end_date,j.next_run_at,
        j.refresh_until,j.failures,j.last_error,
        s.id as latest_snapshot_id,s.fetched_at,
        case when s.id is null then 'pending' when j.last_error is not null then 'error'
          when s.fetched_at < now()-case when j.kind in ('pagespeed','crux') then interval '26 hours' else interval '2 hours' end
          then 'stale' else 'ready' end as state
      from public.google_report_jobs j
      left join lateral (select ss.id,ss.fetched_at from public.google_report_snapshots ss
        where ss.job_id=j.id order by ss.fetched_at desc,ss.id desc limit 1) s on true
      where j.website_id=w.id and j.fqdn=w.fqdn and (p_job_id is null or j.id=p_job_id)
        and (job_cursor is null or j.id<job_cursor)
      order by j.id desc limit p_limit+1
    ) t;
  elsif p_dataset='snapshots' then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc),'[]'::jsonb) into items from (
      select s.id,s.job_id,s.fetched_at,s.data,j.fqdn,j.kind,j.property_id,j.start_date,j.end_date
      from public.google_report_snapshots s join public.google_report_jobs j on j.id=s.job_id
      where j.website_id=w.id and j.fqdn=w.fqdn and (p_job_id is null or j.id=p_job_id)
        and (row_cursor is null or s.id<row_cursor)
      order by s.id desc limit p_limit+1
    ) t;
  else
    select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc),'[]'::jsonb) into items from (
      select c.*,j.fqdn,j.kind,j.property_id from public.google_profile_changes c
      join public.google_report_jobs j on j.id=c.job_id
      where j.website_id=w.id and j.fqdn=w.fqdn and (p_job_id is null or j.id=p_job_id)
        and (row_cursor is null or c.id<row_cursor)
      order by c.id desc limit p_limit+1
    ) t;
  end if;
  more:=jsonb_array_length(items)>p_limit;
  if more then items:=items-p_limit; end if;
  result:=jsonb_build_object('fqdn',w.fqdn,'dataset',p_dataset,'items',items,'has_more',more,
    'next_cursor',case when more then items->(p_limit-1)->>'id' else null end);
  if p_dataset='sources' then
    result:=result || jsonb_build_object('ga4_property_id',w.ga4_property_id,
      'connection_status',(select status from public.google_connections where owner_id=w.owner_id),
      'business_locations',(select coalesce(jsonb_agg(jsonb_build_object('location_id',location_id,'linked_at',linked_at)
        order by location_id),'[]'::jsonb) from public.website_business_locations where website_id=w.id and fqdn=w.fqdn));
  end if;
  return result;
end $$;
revoke all on function public.website_saved_data(text,text,uuid,text,integer) from public,anon;
grant execute on function public.website_saved_data(text,text,uuid,text,integer) to authenticated;
