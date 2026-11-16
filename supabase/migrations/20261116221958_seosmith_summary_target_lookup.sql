-- Keep the existing coverage predicate while allowing a hashed target lookup.
-- H01: additive receiver upgrade; original report bytes are never rewritten.
create or replace function public.seosmith_legacy_summary(r jsonb) returns jsonb language plpgsql stable set search_path='' as $$
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
    select p->>'url' as url from observations
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
    or exists(select 1 from relationships
      where (rel->>'state' is distinct from 'checked' or not exists (select 1 from checked_targets target where target.url=rel->>'url'))
        and not public.seosmith_navigation_excluded(r->'request',p,rel))
    into incomplete;
  return jsonb_build_object('summary_version',3,'schema_version',r->'schema_version','engine_version',r->>'engine_version','ruleset_version',r->>'ruleset_version',
    'started_at',started,'finished_at',finished,'outcome',r->>'outcome','stop_reason',r->>'stop_reason',
    'coverage_complete',coalesce(r->>'coverage_complete'='true' and r->>'outcome'='completed' and coalesce(r->>'stop_reason','frontier_exhausted')='frontier_exhausted' and not incomplete,false),
    'pages',pages,'resources',resources,'findings',jsonb_array_length(r->'findings'),'severities',counts,'rules',rules,
    'comparison_key',encode(sha256(convert_to(jsonb_build_object('request',((r->'request') - 'request_id'::text - 'website_id'::text - 'binding_generation'::text),'engine',r->'engine_version','ruleset',r->'ruleset_version')::text,'UTF8')),'hex'));
end $$;
