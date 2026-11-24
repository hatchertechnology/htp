-- Bounded owner-scoped read of one saved Search/GA4 dataset page.
--
-- The existing /search/dataset contract reads the whole saved snapshot and
-- slices it in the API process. This function selects only the requested page
-- from the latest exact-period snapshot, re-checks ownership in the database,
-- and returns the collection/freshness/truncation metadata the existing API
-- contract already exposes. The full snapshot is never returned to a caller.
--
-- The return shape intentionally mirrors the `saved` object the Rust projection
-- consumes today:
--   data.<dataset>.<rows|analysis.candidates|analysis.landing_outcomes.rows>
--   data.measurement, data.analysis.{comparison,coverage,policy,landing_outcomes}
--   sync, daily_sync
--   page.{retained_rows,has_more,invalid_rows_omitted}
-- plus a `page` object that tells the projection the rows are already bounded.
-- Legacy snapshots without a dataset (or with an explicit unavailable marker)
-- return available=false and a truthful reason, never synthesized zero rows.
--
-- Row bounds: p_limit 1..100. Byte bound: the encoded result must fit
-- p_max_bytes or the read fails closed (`search_page_too_large`). A partial page
-- is never returned because the existing web caller advances a fixed offset.
create function public.read_search_dataset_page(
  p_website_id uuid, p_kind text, p_property_id text,
  p_start_date date, p_end_date date, p_dataset text,
  p_offset integer default 0, p_limit integer default 50,
  p_device text default null, p_country text default null,
  p_max_bytes integer default 262144
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  w public.websites;
  s public.google_report_snapshots;
  latest public.google_report_jobs;
  h jsonb;
  daily_fetched timestamptz;
  source_arr jsonb := '[]'::jsonb;
  filtered jsonb := '[]'::jsonb;
  page jsonb := '[]'::jsonb;
  meta jsonb;
  data jsonb;
  exact boolean := false;
  available boolean := false;
  reason text;
  total integer;
  returned integer;
  omitted integer := 0;
  result jsonb;
begin
  select * into w from public.websites
    where id = p_website_id and owner_id = auth.uid()
      and coalesce(auth.jwt()->>'is_anonymous','true') = 'false';
  if not found then raise insufficient_privilege using message = 'Website not found'; end if;
  if p_kind is null or p_kind not in ('search','conversions')
    or p_property_id is null or length(p_property_id) > 2048
    or p_start_date is null or p_end_date is null
    or p_end_date < p_start_date or p_end_date - p_start_date >= 366
    or (p_kind = 'conversions' and p_property_id is distinct from w.ga4_property_id)
    or p_dataset is null or p_dataset not in
      ('queries','pages','query_pages','query_page_segments','devices','countries','analysis','landing_outcomes')
    or p_offset is null or p_offset < 0 or p_offset > 5000
    or p_limit is null or p_limit < 1 or p_limit > 100
    or p_max_bytes is null or p_max_bytes < 4096 or p_max_bytes > 4194304
    or ((p_device is not null or p_country is not null) and p_dataset <> 'query_page_segments')
    or (p_device is not null and p_device not in ('DESKTOP','MOBILE','TABLET'))
    or (p_country is not null and (length(p_country) <> 3 or p_country !~ '^[a-z]{3}$'))
  then raise invalid_parameter_value using message = 'Invalid search dataset request'; end if;

  select s0.* into s
    from public.google_report_jobs j0
    join public.google_report_snapshots s0 on s0.job_id = j0.id
    where j0.website_id = w.id and j0.fqdn = w.fqdn and j0.kind = p_kind
      and j0.property_id = p_property_id and j0.start_date = p_start_date and j0.end_date = p_end_date
    order by s0.fetched_at desc, s0.id desc limit 1;
  exact := s.id is not null;

  -- Daily canonical metadata mirrors request_google_report's sync without ever
  -- detoasting the exact snapshot payload.
  select * into latest from public.google_report_jobs
    where website_id = w.id and fqdn = w.fqdn and kind = p_kind and property_id = p_property_id
    order by end_date desc, next_run_at limit 1;
  h := public.read_daily_history(w.id, p_kind, p_property_id, p_start_date, p_end_date);
  select coalesce(max((v->>'fetched_at')::timestamptz), s.fetched_at) into daily_fetched
    from jsonb_array_elements(h->'daily') v;

  if not exact then
    available := false;
    reason := 'exact_period_snapshot_unavailable';
  elsif p_dataset = 'analysis' then
    source_arr := s.data#>'{analysis,candidates}';
    if jsonb_typeof(source_arr) is distinct from 'array' then
      available := false; reason := 'dataset_unavailable'; source_arr := '[]'::jsonb;
    else
      available := true;
    end if;
  elsif p_dataset = 'landing_outcomes' then
    if s.data#>>'{analysis,landing_outcomes,available}' = 'true'
      and jsonb_typeof(s.data#>'{analysis,landing_outcomes,rows}') = 'array' then
      available := true;
      source_arr := s.data#>'{analysis,landing_outcomes,rows}';
    else
      available := false;
      reason := coalesce(s.data#>>'{analysis,landing_outcomes,reason}','dataset_unavailable');
    end if;
  else
    if jsonb_typeof(s.data->p_dataset) = 'object'
      and jsonb_typeof(s.data->p_dataset->'rows') = 'array' then
      if p_dataset = 'query_page_segments'
        and s.data#>>'{query_page_segments,unavailable}' = 'true' then
        available := false;
        reason := coalesce(s.data#>>'{query_page_segments,reason}','segment_collection_unavailable');
      else
        available := true;
        source_arr := s.data->p_dataset->'rows';
      end if;
    else
      available := false;
      reason := coalesce(s.data#>>array[p_dataset,'reason'],'dataset_unavailable');
    end if;
  end if;

  if available and p_dataset = 'query_page_segments' then
    select coalesce(jsonb_agg(v order by ord),'[]'::jsonb), count(*)
      into filtered, total
      from jsonb_array_elements(source_arr) with ordinality as t(v,ord)
      where jsonb_typeof(v) = 'object'
        and jsonb_typeof(v->'keys') = 'array' and jsonb_array_length(v->'keys') = 4
        and (select bool_and(jsonb_typeof(k) = 'string') from jsonb_array_elements(v->'keys') k)
        and (p_device is null or v->'keys'->>2 = p_device)
        and (p_country is null or v->'keys'->>3 = p_country);
    select count(*) into omitted from jsonb_array_elements(source_arr) v
      where not (jsonb_typeof(v) = 'object'
        and jsonb_typeof(v->'keys') = 'array' and jsonb_array_length(v->'keys') = 4
        and (select bool_and(jsonb_typeof(k) = 'string') from jsonb_array_elements(v->'keys') k));
    select coalesce(jsonb_agg(v order by ord),'[]'::jsonb) into page
      from (select v, ord from jsonb_array_elements(filtered) with ordinality as t(v,ord)
        order by ord offset p_offset limit p_limit) q;
  elsif available then
    total := jsonb_array_length(source_arr);
    select coalesce(jsonb_agg(v order by ord),'[]'::jsonb) into page
      from (select v, ord from jsonb_array_elements(source_arr) with ordinality as t(v,ord)
        order by ord offset p_offset limit p_limit) q;
  end if;
  returned := jsonb_array_length(page);

  if p_dataset = 'analysis' then
    meta := coalesce(s.data->'analysis','{}'::jsonb);
    if available then meta := meta || jsonb_build_object('candidates',page);
    else meta := meta - 'candidates'; end if;
    data := jsonb_build_object('analysis',meta,'measurement',s.data->'measurement');
  elsif p_dataset = 'landing_outcomes' then
    meta := coalesce(s.data#>'{analysis,landing_outcomes}','{}'::jsonb);
    if available then meta := meta || jsonb_build_object('rows',page);
    else meta := meta - 'rows'; end if;
    data := jsonb_build_object(
      'analysis',jsonb_build_object('landing_outcomes',meta),
      'pages',jsonb_build_object('metadata',s.data#>'{pages,metadata}'),
      'measurement',s.data->'measurement');
  else
    meta := coalesce(s.data->p_dataset,'{}'::jsonb);
    if available then meta := meta || jsonb_build_object('rows',page);
    else meta := meta - 'rows'; end if;
    data := jsonb_build_object(p_dataset,meta,'measurement',s.data->'measurement');
  end if;

  result := jsonb_build_object(
    'data', data,
    'sync', jsonb_build_object(
      'exact_range_available', exact,
      'snapshot_id', s.id,
      'fetched_at', s.fetched_at,
      'state', case when s.id is null then 'unavailable'
        when s.fetched_at < now() - interval '2 hours' then 'stale' else 'ready' end),
    'daily_sync', jsonb_build_object(
      'state', case when daily_fetched is null then 'pending'
        when latest.last_error is not null then 'error'
        when daily_fetched < now() - interval '2 hours' then 'stale' else 'ready' end,
      'fetched_at', daily_fetched,
      'coverage', h->'coverage',
      'exact_range_available', exact,
      'last_error', latest.last_error,
      'next_run_at', latest.next_run_at,
      'cadence', 'hourly',
      'connection_status', (select status from public.google_connections where owner_id = w.owner_id)),
    'page', jsonb_build_object(
      'retained_rows', case when available then total else null end,
      'has_more', case when available then p_offset + returned < total else false end,
      'invalid_rows_omitted', case when p_dataset = 'query_page_segments' then omitted else 0 end));
  if octet_length(result::text) > p_max_bytes then
    raise exception 'search_page_too_large' using errcode = '54000';
  end if;
  return result;
end $$;
revoke all on function public.read_search_dataset_page(uuid,text,text,date,date,text,integer,integer,text,text,integer) from public, anon;
grant execute on function public.read_search_dataset_page(uuid,text,text,date,date,text,integer,integer,text,text,integer) to authenticated;
