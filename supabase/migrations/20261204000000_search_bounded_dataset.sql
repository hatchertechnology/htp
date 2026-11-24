-- Bounded owner-scoped read of one saved Search/GA4 dataset page.
--
-- The existing /search/dataset contract reads the whole saved snapshot and
-- slices it in the API process. This function selects only the requested page
-- from the latest exact-period snapshot, re-checks ownership in the database,
-- and returns only the fields the Rust projection consumes. The full snapshot
-- is still loaded inside the database, but the API transfer is bounded; it is
-- never returned to the caller.
--
-- The return shape mirrors the `saved` object the Rust projection consumes:
--   data.<dataset>.{rows,collection,reason}
--   data.analysis.{semantics_version,comparison,coverage,policy,reason}
--   data.analysis.candidates (per-candidate evidence trimmed to 25 rows)
--   data.analysis.landing_outcomes.{available,reason,collection,attribution,rows}
--   data.pages.metadata.currencyCode, data.measurement
--   sync, daily_sync
--   page.{retained_rows,has_more,invalid_rows_omitted}
-- plus a `page` object that tells the projection the rows are already bounded.
-- An analysis read never carries the sibling `landing_outcomes` rows.
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

  -- The validity predicate is computed once per row with a CASE, so the type
  -- test always runs before jsonb_array_length/jsonb_array_elements. A missing
  -- `keys` member (SQL NULL) is invalid, not unknown, and is counted as omitted.
  -- The page and the two counts come from one scan; a full filtered array is
  -- never materialized. Paging is over `valid_rank`, the rank of a row among
  -- the shape-valid rows that also pass the device/country filter, not the raw
  -- source ordinal. Otherwise malformed rows and rows filtered out by
  -- device/country would consume page slots and the fixed-offset caller would
  -- see short or duplicate pages.
  if available and p_dataset = 'query_page_segments' then
    select
        coalesce(jsonb_agg(v order by ord)
          filter (where valid and valid_rank > p_offset and valid_rank <= p_offset + p_limit),'[]'::jsonb),
        count(*) filter (where valid),
        count(*) filter (where not shape_valid)
      into page, total, omitted
      from (
        select v, ord, shape_valid, keys, valid,
            count(*) filter (where valid) over (order by ord
              rows between unbounded preceding and current row) as valid_rank
          from (
            select v, ord, x.shape_valid, x.keys,
                x.shape_valid
                and (p_device is null or x.keys->>2 = p_device)
                and (p_country is null or x.keys->>3 = p_country) as valid
              from jsonb_array_elements(source_arr) with ordinality as t(v,ord)
              cross join lateral (
                select
                  case
                    when jsonb_typeof(v) <> 'object' then false
                    when jsonb_typeof(v->'keys') is distinct from 'array' then false
                    when jsonb_array_length(v->'keys') <> 4 then false
                    when exists (select 1 from jsonb_array_elements(v->'keys') as e(value)
                      where jsonb_typeof(value) is distinct from 'string') then false
                    else true
                  end as shape_valid,
                  case when jsonb_typeof(v) = 'object' and jsonb_typeof(v->'keys') = 'array'
                    then v->'keys' else null end as keys
              ) x
          ) shaped
      ) elements;
  elsif available then
    total := jsonb_array_length(source_arr);
    select coalesce(jsonb_agg(v order by ord),'[]'::jsonb) into page
      from (select v, ord from jsonb_array_elements(source_arr) with ordinality as t(v,ord)
        order by ord offset p_offset limit p_limit) q;
  end if;
  returned := jsonb_array_length(page);

  if p_dataset = 'analysis' then
    if available then
      -- Match the public 25-row evidence bound in SQL so the byte budget applies
      -- to the same page the API returns; the full evidence stays in the saved
      -- snapshot and in the query_pages dataset.
      select coalesce(jsonb_agg(
        case
          when jsonb_typeof(c->'evidence') = 'array' then
            c || jsonb_build_object(
              'evidence', coalesce((select jsonb_agg(e.value order by e.ord)
                from jsonb_array_elements(c->'evidence') with ordinality as e(value,ord)
                where e.ord <= 25),'[]'::jsonb),
              'evidence_presentation', jsonb_build_object(
                'retained_rows', jsonb_array_length(c->'evidence'),
                'returned_rows', least(jsonb_array_length(c->'evidence'),25),
                'truncated', jsonb_array_length(c->'evidence') > 25))
          else c
        end order by ord),'[]'::jsonb)
        into page
        from jsonb_array_elements(page) with ordinality as t(c,ord);
    end if;
    meta := jsonb_build_object(
      'semantics_version', s.data#>'{analysis,semantics_version}',
      'policy', s.data#>'{analysis,policy}',
      'coverage', s.data#>'{analysis,coverage}',
      'comparison', s.data#>'{analysis,comparison}');
    if available then meta := meta || jsonb_build_object('candidates',page);
    else meta := meta || jsonb_build_object('reason',s.data#>'{analysis,reason}'); end if;
    data := jsonb_build_object('analysis',meta,'measurement',s.data->'measurement');
  elsif p_dataset = 'landing_outcomes' then
    meta := jsonb_build_object(
      'available', s.data#>'{analysis,landing_outcomes,available}',
      'reason', s.data#>'{analysis,landing_outcomes,reason}',
      'collection', s.data#>'{analysis,landing_outcomes,collection}',
      'attribution', s.data#>'{analysis,landing_outcomes,attribution}');
    if available then meta := meta || jsonb_build_object('rows',page); end if;
    data := jsonb_build_object(
      'analysis',jsonb_build_object('landing_outcomes',meta),
      'pages',jsonb_build_object('metadata',s.data#>'{pages,metadata}'),
      'measurement',s.data->'measurement');
  else
    meta := jsonb_build_object(
      'collection', s.data#>array[p_dataset,'collection'],
      'reason', s.data#>array[p_dataset,'reason']);
    if available then meta := meta || jsonb_build_object('rows',page); end if;
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
