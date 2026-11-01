-- Complete means the configured frontier finished. Deliberately excluded
-- navigation is still unknown evidence for target-dependent finding resolution.
-- Keep this as a new migration: version-2 summaries already exist in production.
create function public.seosmith_navigation_excluded(request jsonb, page jsonb, relation jsonb)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(
    relation->>'kind'='navigation' and relation->>'resource'='false'
    and relation->>'state' in ('outside_scope','not_fetched')
    and (
      -- Resource HTML is not a navigation discovery source.
      page->>'is_resource'='true'
      or lower(coalesce(page->>'robots','')) ~ '(^|[[:space:],;])(nofollow|none)([[:space:],;]|$)'
      or lower(coalesce(relation->>'descriptor','')) ~ '(^|[[:space:]])(nofollow|sponsored|ugc)([[:space:]]|$)'
      or (
        coalesce(request->>'check_external_links','false')='false'
        and substring(relation->>'url' from '^https?://([^/?#:@[:space:]]+)') is not null
        and substring(request->>'url' from '^https?://([^/?#:@[:space:]]+)') is not null
        and lower(substring(relation->>'url' from '^https?://([^/?#:@[:space:]]+)'))
          <> lower(substring(request->>'url' from '^https?://([^/?#:@[:space:]]+)'))
      )
    ), false)
$$;
revoke all on function public.seosmith_navigation_excluded(jsonb,jsonb,jsonb) from public,anon,authenticated;

create or replace function public.seosmith_summary(r jsonb) returns jsonb language plpgsql stable set search_path='' as $$
declare counts jsonb; rules jsonb; pages jsonb; resources jsonb; incomplete boolean; finished timestamptz; started timestamptz;
begin
  if jsonb_typeof(r) is distinct from 'object' or r->>'schema_version' is distinct from '1' or
     jsonb_typeof(r->'pages') is distinct from 'array' or jsonb_typeof(r->'findings') is distinct from 'array' or
     coalesce(r->>'outcome','') not in ('completed','partial','failed','cancelled') then
    raise exception 'invalid_seosmith_report' using errcode='22023';
  end if;
  if jsonb_array_length(r->'pages')>40000 or jsonb_array_length(r->'findings')>400000 or
     exists(select 1 from jsonb_array_elements(r->'findings') f where jsonb_typeof(f) is distinct from 'object' or coalesce(f->>'severity','') not in ('critical','alert','warning') or coalesce(f->>'rule','')='' or coalesce(f->>'url','')='') then
    raise exception 'invalid_seosmith_findings' using errcode='22023';
  end if;
  started := nullif(r->>'started_at','')::timestamptz;
  finished := nullif(r->>'finished_at','')::timestamptz;
  if finished < started then raise exception 'invalid_scan_dates' using errcode='22023'; end if;
  select jsonb_build_object('critical',count(*) filter(where f->>'severity'='critical'),'alert',count(*) filter(where f->>'severity'='alert'),'warning',count(*) filter(where f->>'severity'='warning')) into counts from jsonb_array_elements(r->'findings') f;
  select coalesce(jsonb_object_agg(rule,n),'{}'::jsonb) into rules from (select f->>'rule' rule,count(*) n from jsonb_array_elements(r->'findings') f group by f->>'rule') q;
  -- Missing is_resource is the schema-1 page default. Never mix resource HTML
  -- into page metadata counts. Validate both independent observation budgets.
  if exists(select 1 from jsonb_array_elements(r->'pages') p
      where jsonb_typeof(p) is distinct from 'object'
      or (p ? 'is_resource' and jsonb_typeof(p->'is_resource') is distinct from 'boolean')) or
     (select count(*) from jsonb_array_elements(r->'pages') p where p->>'is_resource'='true')>20000 or
     (select count(*) from jsonb_array_elements(r->'pages') p where coalesce(p->>'is_resource','false')='false')>20000 then
    raise exception 'report_limit' using errcode='22023';
  end if;
  if exists(select 1 from (values ('max_pages',1),('max_resources',0)) budget(name,minimum)
      where r->'request' ? name and
      (coalesce(r#>>array['request',name],'') !~ '^[0-9]{1,5}$' or
       case when r#>>array['request',name] ~ '^[0-9]{1,5}$'
         then (r#>>array['request',name])::integer not between minimum and 20000 else true end)) then
    raise exception 'report_limit' using errcode='22023';
  end if;
  select public.seosmith_observation_counts(coalesce(jsonb_agg(p) filter(where coalesce(p->>'is_resource','false')='false'),'[]'::jsonb)),
         public.seosmith_observation_counts(coalesce(jsonb_agg(p) filter(where p->>'is_resource'='true'),'[]'::jsonb))
    into pages,resources from jsonb_array_elements(r->'pages') p;
  -- Do not infer that absent findings were resolved when extraction or target
  -- observations are unknown, even if a producer claimed complete coverage.
  with observations as materialized (select p from jsonb_array_elements(r->'pages') p),
  checked_targets as materialized (
    select distinct p->>'url' as url from observations
    where p->>'status' ~ '^[1-5][0-9]{2}$' and p->>'error' is null
      and coalesce(p->>'blocked_by_robots','false')='false'
  ), relationships as (
    select p,rel from observations
    cross join lateral jsonb_array_elements(coalesce(p->'relationships','[]'::jsonb)) rel
  )
  select exists(select 1 from observations
    where p->>'extraction_truncated'='true' or p->>'blocked_by_robots'='true' or p->>'error' is not null
      or coalesce(p->>'status','') !~ '^[1-5][0-9]{2}$'
      or exists(select 1 from jsonb_array_elements_text(coalesce(p->'flags','[]'::jsonb)) flag
        where flag in ('extraction_limit','discovery_limit','legacy_checkpoint_metadata')))
    or exists(select 1 from relationships left join checked_targets target on target.url=rel->>'url'
      where (rel->>'state' is distinct from 'checked' or target.url is null)
        and not public.seosmith_navigation_excluded(r->'request',p,rel))
    into incomplete;
  return jsonb_build_object('summary_version',3,'schema_version',r->'schema_version','engine_version',r->>'engine_version','ruleset_version',r->>'ruleset_version',
    'started_at',started,'finished_at',finished,'outcome',r->>'outcome','stop_reason',r->>'stop_reason',
    'coverage_complete',coalesce(r->>'coverage_complete'='true' and r->>'outcome'='completed' and coalesce(r->>'stop_reason','frontier_exhausted')='frontier_exhausted' and not incomplete,false),
    'pages',pages,'resources',resources,'findings',jsonb_array_length(r->'findings'),'severities',counts,'rules',rules,
    'comparison_key',encode(sha256(convert_to(jsonb_build_object('request',((r->'request') - 'request_id'::text - 'website_id'::text - 'binding_generation'::text),'engine',r->'engine_version','ruleset',r->'ruleset_version')::text,'UTF8')),'hex'));
end $$;

create or replace function public.seosmith_audit_history(p_website_id uuid,p_limit integer default 50,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; rows jsonb; more boolean; last_row jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 or (p_before is null)<>(p_before_id is null) then raise exception 'invalid_cursor_or_limit' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.scan_at desc,a.delivery_id desc),'[]'::jsonb) into rows from
    (select delivery_id,scan_at,received_at,ingestion_source,case when summary->>'summary_version'='3' then summary else public.seosmith_summary(report) end as summary from public.seosmith_audits where website_id=w.id and fqdn=w.fqdn and (p_before is null or (scan_at,delivery_id)<(p_before,p_before_id)) order by scan_at desc,delivery_id desc limit p_limit+1) a;
  more:=jsonb_array_length(rows)>p_limit;
  if more then rows:=rows-p_limit; end if;
  last_row:=rows->(jsonb_array_length(rows)-1);
  return jsonb_build_object('items',rows,'has_more',more,'next_cursor',case when more then jsonb_build_object('before',last_row->>'scan_at','before_id',last_row->>'delivery_id') else null end);
end $$;
revoke all on function public.seosmith_audit_history(uuid,integer,timestamptz,uuid) from public;
grant execute on function public.seosmith_audit_history(uuid,integer,timestamptz,uuid) to authenticated;

create or replace function public.seosmith_audit_detail(p_website_id uuid,p_delivery_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; result jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  select jsonb_build_object('delivery_id',delivery_id,'scan_at',scan_at,'received_at',received_at,'ingestion_source',ingestion_source,'summary',case when summary->>'summary_version'='3' then summary else public.seosmith_summary(report) end,'report',report,'report_json',raw_report_json) into result from public.seosmith_audits where website_id=w.id and fqdn=w.fqdn and delivery_id=p_delivery_id;
  return result;
end $$;
revoke all on function public.seosmith_audit_detail(uuid,uuid) from public;
grant execute on function public.seosmith_audit_detail(uuid,uuid) to authenticated;

