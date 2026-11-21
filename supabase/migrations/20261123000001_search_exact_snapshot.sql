-- Exact snapshot and its provenance are selected atomically; canonical daily
-- freshness is a separate observation and must not label these dimensions.
create function public.read_search_exact_snapshot(p_website_id uuid, p_kind text, p_property_id text,
 p_start_date date, p_end_date date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w public.websites; s public.google_report_snapshots;
begin
 select * into w from public.websites where id=p_website_id and owner_id=auth.uid()
   and coalesce(auth.jwt()->>'is_anonymous','true')='false';
 if not found then raise insufficient_privilege using message='Website not found'; end if;
 if p_kind is null or p_kind not in ('search','conversions') or p_property_id is null
   or length(p_property_id)>2048 or p_start_date is null or p_end_date is null
   or p_end_date<p_start_date or p_end_date-p_start_date>=366
   or (p_kind='conversions' and p_property_id is distinct from w.ga4_property_id) then
   raise invalid_parameter_value using message='Invalid exact snapshot request';
 end if;
 select s0.* into s from public.google_report_jobs j join public.google_report_snapshots s0 on s0.job_id=j.id
   where j.website_id=w.id and j.fqdn=w.fqdn and j.kind=p_kind and j.property_id=p_property_id
     and j.start_date=p_start_date and j.end_date=p_end_date
   order by s0.fetched_at desc,s0.id desc limit 1;
 return jsonb_build_object('data',s.data,'sync',jsonb_build_object(
   'exact_range_available',s.id is not null,'snapshot_id',s.id,'fetched_at',s.fetched_at,
   'state',case when s.id is null then 'unavailable' when s.fetched_at<now()-interval '2 hours' then 'stale' else 'ready' end));
end $$;
revoke all on function public.read_search_exact_snapshot(uuid,text,text,date,date) from public,anon;
grant execute on function public.read_search_exact_snapshot(uuid,text,text,date,date) to authenticated;
