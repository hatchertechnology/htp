-- H01: additive receiver upgrade; original report bytes are never rewritten.
create function public.seosmith_legacy_summary(r jsonb) returns jsonb language plpgsql stable set search_path='' as $$
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


revoke all on function public.seosmith_legacy_summary(jsonb) from public,anon,authenticated;

-- Capability data comes from the installed database migration, not API build age.
create function public.seosmith_receiver_capabilities() returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('receiver','htp','schema_versions',jsonb_build_array(1,2),
    'evidence_contract_versions',jsonb_build_array(1),'max_evidence_observations',128,
    'max_evaluations',512,'max_evidence_contract_bytes',1048576,
    'max_schema2_nesting_depth',64,'schema2_unique_object_keys',true,
    'max_report_bytes',16777216,'max_pages',20000,'max_resources',20000,
    'max_observations',40000,'max_findings',400000,
    'exact_bytes',true,'receipt_fields',jsonb_build_array('delivery_id','sha256','accepted'))
$$;
revoke all on function public.seosmith_receiver_capabilities() from public;
grant execute on function public.seosmith_receiver_capabilities() to anon,authenticated;

-- IDs are domain-separated by entity kind and use the stored URL verbatim.
create function public.seosmith_entity_id(page jsonb) returns text
language sql immutable set search_path='' as $$
  select 'sha256:' || encode(sha256(convert_to('seosmith-entity-v1' || chr(10) ||
    case when page->>'is_resource'='true' then 'resource' else 'page' end || chr(10) ||
    (page->>'url'),'UTF8')),'hex')
$$;
revoke all on function public.seosmith_entity_id(jsonb) from public,anon,authenticated;

-- Locators address the original report arrays, never a filtered/reordered view.
create function public.seosmith_source_value(r jsonb, locator text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare parts text[]; part text; value jsonb := r;
begin
  if locator is null or locator !~ '^/(pages|findings)/(0|[1-9][0-9]*)(/|$)'
     or locator ~ '~([^01]|$)' then
    raise exception 'invalid_evidence_locator' using errcode='22023';
  end if;
  parts := string_to_array(substring(locator from 2),'/');
  foreach part in array parts loop
    part := replace(replace(part,'~1','/'),'~0','~');
    if jsonb_typeof(value)='array' then
      if part !~ '^(0|[1-9][0-9]{0,8})$' then
        raise exception 'invalid_evidence_locator' using errcode='22023';
      end if;
      value := value->(part::integer);
    elsif jsonb_typeof(value)='object' then value := value->part;
    else value := null;
    end if;
    if value is null then raise exception 'invalid_evidence_locator' using errcode='22023'; end if;
  end loop;
  return value;
end $$;
revoke all on function public.seosmith_source_value(jsonb,text) from public,anon,authenticated;

-- Strip only JSON formatting whitespace, never whitespace inside a string.
create function public.seosmith_compact_json_size(value jsonb) returns bigint
language sql immutable set search_path='' as $$
  select coalesce(sum(octet_length(token[1])),0)::bigint
  from regexp_matches(value::text, '"(?:[^"\\]|\\.)*"|[^"[:space:]]+', 'g') token
$$;
revoke all on function public.seosmith_compact_json_size(jsonb) from public,anon,authenticated;

create function public.seosmith_validate_evidence(r jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare
  c jsonb := r->'evidence_contract'; o jsonb; e jsonb; v jsonb; p jsonb; src jsonb;
  coverage jsonb; policy jsonb; rule_ids jsonb; n integer; observed integer; omitted integer;
  field text; reason text; expected_count integer; actual_count integer; complete boolean; canonical text;
begin
  if r->'schema_version' is distinct from '2'::jsonb or jsonb_typeof(c) is distinct from 'object'
     or c->'version' is distinct from '1'::jsonb then
    raise exception 'unsupported_evidence_contract' using errcode='22023';
  end if;
  if jsonb_typeof(c->'observations') is distinct from 'array' or
     jsonb_typeof(c->'evaluations') is distinct from 'array' or
     jsonb_typeof(c->'coverage') is distinct from 'array' or
     jsonb_typeof(c->'truncated') is distinct from 'boolean' or
     jsonb_typeof(c->'evaluation_coverage_complete') is distinct from 'boolean' then
    raise exception 'invalid_evidence_contract' using errcode='22023';
  end if;
  if jsonb_array_length(c->'observations')>128 or jsonb_array_length(c->'evaluations')>512 or
     public.seosmith_compact_json_size(c)>1048576 then
    raise exception 'evidence_contract_limit' using errcode='22023';
  end if;
  n := jsonb_array_length(r->'pages'); observed := jsonb_array_length(c->'observations');
  if jsonb_typeof(c->'omitted_observations') is distinct from 'number' or
     (c->>'omitted_observations') !~ '^[0-9]{1,5}$' then
    raise exception 'invalid_evidence_coverage' using errcode='22023';
  end if;
  omitted := (c->>'omitted_observations')::integer;
  if omitted<>n-observed or (omitted>0 and c->>'truncated'<>'true') then
    raise exception 'invalid_evidence_coverage' using errcode='22023';
  end if;
  if jsonb_typeof(c#>'{policy,canonical_json}') is distinct from 'string' or
     c#>>'{policy,signature}' is distinct from 'sha256:' || encode(sha256(convert_to(c#>>'{policy,canonical_json}','UTF8')),'hex') or
     c->>'comparison_key' is distinct from c#>>'{policy,signature}' then
    raise exception 'invalid_evidence_policy' using errcode='22023';
  end if;
  policy := (c#>>'{policy,canonical_json}')::jsonb;
  if policy->>'policy_version' is distinct from 's01-1' or policy->>'validator_version' is distinct from 's01-1' or
     policy->'engine_version' is distinct from r->'engine_version' or
     policy->'ruleset_version' is distinct from r->'ruleset_version' or
     policy->'seed_url' is distinct from r#>'{request,url}' then
    raise exception 'invalid_evidence_policy' using errcode='22023';
  end if;
  foreach field in array array['max_pages','max_resources','max_duration_seconds','delay_ms','check_external_links'] loop
    if policy->field is distinct from r->'request'->field then
      raise exception 'invalid_evidence_policy' using errcode='22023';
    end if;
  end loop;
  if policy is distinct from jsonb_build_object(
      'policy_version','s01-1','validator_version','s01-1',
      'engine_version',r->'engine_version','ruleset_version',r->'ruleset_version',
      'seed_url',r#>'{request,url}','max_pages',r#>'{request,max_pages}',
      'max_resources',r#>'{request,max_resources}','max_duration_seconds',r#>'{request,max_duration_seconds}',
      'delay_ms',r#>'{request,delay_ms}','check_external_links',r#>'{request,check_external_links}') then
    raise exception 'invalid_evidence_policy' using errcode='22023';
  end if;
  select '{' || string_agg(to_jsonb(key)::text || ':' || value::text,',' order by key collate "C") || '}' into canonical
    from jsonb_each(policy);
  if canonical is distinct from c#>>'{policy,canonical_json}' then
    raise exception 'noncanonical_evidence_policy' using errcode='22023';
  end if;
  if c#>>'{observed_at,started_at}' is distinct from r->>'started_at' or
     c#>>'{observed_at,finished_at}' is distinct from r->>'finished_at' or
     coalesce(r->>'started_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$' or
     coalesce(r->>'finished_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$' then
    raise exception 'invalid_evidence_interval' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(r->'pages') page
      where jsonb_typeof(page->'url') is distinct from 'string' or page->>'url'='') or
     exists(select 1 from jsonb_array_elements(r->'pages') page group by public.seosmith_entity_id(page) having count(*)>1) or
     exists(select 1 from jsonb_array_elements(c->'observations') obs group by obs->>'entity_id' having count(*)>1) or
     exists(select 1 from jsonb_array_elements(c->'evaluations') ev group by ev->>'entity_id',ev->>'rule' having count(*)>1) then
    raise exception 'invalid_evidence_identity' using errcode='22023';
  end if;
  for o in select value from jsonb_array_elements(c->'observations') loop
    if coalesce(o->>'source_locator','') !~ '^/pages/(0|[1-9][0-9]*)$' then
      raise exception 'invalid_evidence_locator' using errcode='22023';
    end if;
    p := public.seosmith_source_value(r,o->>'source_locator');
    reason := case when p->>'blocked_by_robots'='true' then 'robots_blocked'
      when p->>'error' is not null then 'fetch_failed' when p->>'status' is null then 'not_fetched' else null end;
    if o->>'entity_id' is distinct from public.seosmith_entity_id(p) or
       o->>'state' is distinct from (case when reason is null then 'available' else 'unavailable' end) or
       o->>'unknown_reason' is distinct from reason then
      raise exception 'invalid_evidence_observation' using errcode='22023';
    end if;
  end loop;
  rule_ids := '["invalid_language","invalid_hreflang","invalid_json_ld","meta_refresh","broken_resource","insecure_resource","encoding_errors","http_redirect","http_client_error","http_server_error","fetch_error","external_link_broken","external_link_redirect","large_image","incorrect_media_type","robots_blocked","missing_title","short_title","long_title","missing_description","short_description","long_description","multiple_title_tags","multiple_description_tags","noindex","nosnippet","noimageindex","missing_h1","heading_order","missing_language","little_content","missing_image_alt","long_image_alt","image_without_size","picture_without_img","duplicate_ids","large_dom","missing_viewport","meta_in_body","form_on_http","insecure_form","missing_hsts","missing_csp","missing_nosniff","http_scheme","http_links","localhost_links","underscore_url","space_url","multiple_slashes","slow_ttfb","deep_page","too_many_links","deadend","internal_nofollow","multiple_canonicals","relative_canonical","canonical_mismatch","sitemap_noindex","sitemap_blocked","sitemap_noncanonical","duplicate_title","duplicate_description","duplicate_content","broken_internal_link","redirect_chain","redirect_loop","orphan_page","mixed_incoming_rel","nofollow_indexable","canonical_to_error","canonical_to_redirect","canonical_to_noindex","canonical_chain","missing_hreflang_xdefault","missing_hreflang_self","hreflang_language_mismatch","relative_hreflang","hreflang_return_missing","hreflang_to_error","hreflang_to_redirect","hreflang_to_noindex","hreflang_noncanonical","hreflang_multiple_languages","pagination_not_linked"]'::jsonb;
  if r->>'ruleset_version' is distinct from '2026-11-01.1' or
     jsonb_array_length(c->'coverage')<>jsonb_array_length(rule_ids) or
     exists(select 1 from jsonb_array_elements(c->'coverage') cov group by cov->>'rule' having count(*)>1) or
     exists(select 1 from jsonb_array_elements(c->'coverage') cov where not (rule_ids ? (cov->>'rule'))) then
    raise exception 'unsupported_evidence_ruleset' using errcode='22023';
  end if;
  for e in select value from jsonb_array_elements(c->'evaluations') loop
    select obs into o from jsonb_array_elements(c->'observations') obs where obs->>'entity_id'=e->>'entity_id';
    if o is null or not (rule_ids ? coalesce(e->>'rule','')) or
       e->>'rule_version' is distinct from r->>'ruleset_version' or
       e->>'validator_version' is distinct from 's01-1' or
       coalesce(e->>'eligibility','') not in ('eligible','ineligible','unknown') or
       coalesce(e->>'attempt','') not in ('completed','not_attempted','unknown') or
       coalesce(e->>'outcome','') not in ('pass','fail','not_applicable','unknown') or
       coalesce(e->>'confidence','') not in ('high','unknown') then
      raise exception 'invalid_evidence_evaluation' using errcode='22023';
    end if;
    p := public.seosmith_source_value(r,o->>'source_locator');
    src := public.seosmith_source_value(r,e->>'source_locator');
    if e->>'finding_key' is not null then
      if coalesce(e->>'source_locator','') !~ '^/findings/(0|[1-9][0-9]*)$' or
         src->>'key' is distinct from e->>'finding_key' or src->>'rule' is distinct from e->>'rule' or
         src->>'url' is distinct from p->>'url' or e->>'outcome'<>'fail' then
        raise exception 'invalid_evidence_finding' using errcode='22023';
      end if;
    elsif e->>'source_locator' is distinct from o->>'source_locator' then
      raise exception 'invalid_evidence_identity' using errcode='22023';
    end if;
    if (e->>'outcome' in ('pass','fail') and
        (e->>'eligibility'<>'eligible' or e->>'attempt'<>'completed' or e->>'unknown_reason' is not null or e->>'confidence'<>'high')) or
       (e->>'outcome'='not_applicable' and
        (e->>'eligibility'<>'ineligible' or e->>'attempt'<>'not_attempted' or e->>'unknown_reason' is not null or e->>'confidence'<>'high' or e->'actual' is distinct from jsonb_build_object('state','unavailable','reason','not_html_page'))) or
       (e->>'outcome'='unknown' and (coalesce(e->>'unknown_reason','') not in ('source_unavailable','extraction_truncated') or
         e->>'eligibility'<>'unknown' or e->>'attempt'<>'not_attempted' or e->>'confidence'<>'unknown' or
         e->'actual' is distinct from jsonb_build_object('state','unavailable','reason',e->>'unknown_reason'))) then
      raise exception 'invalid_evidence_outcome' using errcode='22023';
    end if;
    if (e->>'outcome'='fail' and e->>'finding_key' is null) or
       (e->>'outcome'<>'fail' and e->>'rule'<>'missing_title') or
       (e->>'rule'='missing_title' and e->>'outcome' in ('pass','fail') and
         (p->>'extraction_truncated'='true' or p->>'blocked_by_robots'='true' or p->>'error' is not null or
          coalesce(p->>'status','') !~ '^2[0-9]{2}$' or p->>'is_resource'='true' or
          lower(btrim(split_part(p->>'content_type',';',1))) not in ('text/html','application/xhtml+xml','application/vnd.wap.xhtml+xml') or
          (e->>'outcome'='pass' and btrim(coalesce(p->>'title',''))='') or
          (e->>'outcome'='fail' and btrim(coalesce(p->>'title',''))<>''))) then
      raise exception 'invalid_evidence_outcome' using errcode='22023';
    end if;
    foreach field in array array['actual','expected'] loop
      v := e->field;
      if jsonb_typeof(v) is distinct from 'object' or coalesce(v->>'state','') not in ('source','known','unavailable') or
         (v->>'state'='known' and jsonb_typeof(v->'value') is distinct from 'string') or
         (v->>'state'='unavailable' and coalesce(v->>'reason','')='') then
        raise exception 'invalid_evidence_value' using errcode='22023';
      end if;
      if v->>'state'='source' then
        perform public.seosmith_source_value(r,v->>'source_locator');
        if v->>'source_locator' is distinct from e->>'source_locator' and
           left(v->>'source_locator',length(e->>'source_locator')+1) is distinct from (e->>'source_locator') || '/' then
          raise exception 'invalid_evidence_identity' using errcode='22023';
        end if;
      end if;
    end loop;
  end loop;
  for coverage in select value from jsonb_array_elements(c->'coverage') loop
    foreach field in array array['entities','eligible','ineligible','eligibility_unknown','attempted','not_attempted','attempt_unknown','passed','failed','not_applicable','unknown'] loop
      if jsonb_typeof(coverage->field) is distinct from 'number' or coalesce(coverage->>field,'') !~ '^[0-9]{1,5}$' then
        raise exception 'invalid_evidence_coverage' using errcode='22023';
      end if;
    end loop;
    if (coverage->>'entities')::integer<>n or
       (coverage->>'eligible')::integer+(coverage->>'ineligible')::integer+(coverage->>'eligibility_unknown')::integer<>n or
       (coverage->>'attempted')::integer+(coverage->>'not_attempted')::integer+(coverage->>'attempt_unknown')::integer<>n or
       (coverage->>'passed')::integer+(coverage->>'failed')::integer+(coverage->>'not_applicable')::integer+(coverage->>'unknown')::integer<>n or
       jsonb_typeof(coverage->'unknown_reasons') is distinct from 'object' then
      raise exception 'invalid_evidence_coverage' using errcode='22023';
    end if;
    for field,reason in select * from (values ('eligible','eligible'),('ineligible','ineligible'),('attempted','completed'),('not_attempted','not_attempted'),('passed','pass'),('failed','fail'),('not_applicable','not_applicable')) fields(name,state) loop
      select count(*) into expected_count from jsonb_array_elements(c->'evaluations') ev
        where ev->>'rule'=coverage->>'rule' and ev->>case when field in ('eligible','ineligible') then 'eligibility' when field in ('attempted','not_attempted') then 'attempt' else 'outcome' end=reason;
      if (coverage->>field)::integer<>expected_count then
        raise exception 'invalid_evidence_coverage' using errcode='22023';
      end if;
    end loop;
    if exists(select 1 from jsonb_each(coverage->'unknown_reasons') q
        where q.key not in ('legacy_not_instrumented','contract_limit','source_unavailable','extraction_truncated') or jsonb_typeof(q.value)<>'number' or q.value::text !~ '^[0-9]{1,5}$') then
      raise exception 'invalid_evidence_coverage' using errcode='22023';
    end if;
    select coalesce(sum(value::text::integer),0) into actual_count from jsonb_each(coverage->'unknown_reasons');
    if actual_count<>(coverage->>'unknown')::integer or
       (coverage->'unknown_reasons' ? 'contract_limit' and c->>'truncated'<>'true') then
      raise exception 'invalid_evidence_coverage' using errcode='22023';
    end if;
    for reason in select unnest(array['source_unavailable','extraction_truncated']) loop
      select count(*) into expected_count from jsonb_array_elements(c->'evaluations') ev
        where ev->>'rule'=coverage->>'rule' and ev->>'outcome'='unknown' and ev->>'unknown_reason'=reason;
      if coalesce((coverage->'unknown_reasons'->>reason)::integer,0)<>expected_count then
        raise exception 'invalid_evidence_coverage' using errcode='22023';
      end if;
    end loop;
  end loop;
  complete := r->'coverage_complete'='true'::jsonb and c->'truncated'='false'::jsonb and
    not exists(select 1 from jsonb_array_elements(c->'coverage') cov where (cov->>'unknown')::integer>0);
  if c->'evaluation_coverage_complete' is distinct from to_jsonb(coalesce(complete,false)) then
    raise exception 'invalid_evidence_coverage' using errcode='22023';
  end if;
end $$;
revoke all on function public.seosmith_validate_evidence(jsonb) from public,anon,authenticated;

create or replace function public.seosmith_summary(r jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare summary jsonb; c jsonb := r->'evidence_contract';
begin
  if r->'schema_version'='1'::jsonb then
    if r ? 'evidence_contract' then raise exception 'unexpected_evidence_contract' using errcode='22023'; end if;
    summary := public.seosmith_legacy_summary(r);
    return summary || jsonb_build_object('summary_version',4,'evidence_contract_version',null,
      'evaluation_coverage_complete',null,'evidence_state','legacy_unknown');
  elsif r->'schema_version'='2'::jsonb then
    -- Reuse every existing crawl-policy guard; only adapt the version for this private call.
    summary := public.seosmith_legacy_summary(jsonb_set(r,'{schema_version}','1'::jsonb));
    perform public.seosmith_validate_evidence(r);
    return summary || jsonb_build_object('summary_version',4,'schema_version',2,
      'evidence_contract_version',1,'evidence_state','versioned',
      'evaluation_coverage_complete',c->'evaluation_coverage_complete',
      'crawl_coverage_complete',summary->'coverage_complete',
      'coverage_complete',summary->'coverage_complete'='true'::jsonb and c->'evaluation_coverage_complete'='true'::jsonb,
      'evidence_truncated',c->'truncated','omitted_observations',c->'omitted_observations',
      'policy_digest',c#>>'{policy,signature}',
      'comparison_key',encode(sha256(convert_to((summary->>'comparison_key') || chr(10) || 'schema:2' || chr(10) || (c->>'comparison_key'),'UTF8')),'hex'));
  end if;
  raise exception 'unsupported_seosmith_schema' using errcode='22023';
end $$;
revoke all on function public.seosmith_summary(jsonb) from public,anon,authenticated;

-- Scan structural tokens without parsing the document or counting delimiters in strings.
-- Root keys are decoded so escaped spellings of schema_version cannot bypass the gate.
create function public.seosmith_check_raw_report(raw text) returns void
language plpgsql immutable set search_path='' as $$
declare tok text[]; token text; depth integer:=0; max_depth integer:=0;
  awaiting_colon boolean:=false; awaiting_version boolean:=false; is_v2 boolean:=false;
begin
  for tok in select regexp_matches(raw, '"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null', 'g') loop
    token:=tok[1];
    if awaiting_colon then
      awaiting_colon:=false;
      if token=':' then awaiting_version:=true; end if;
    elsif awaiting_version then
      awaiting_version:=false;
      if token ~ '^-?[0-9]' and token::numeric=2 then is_v2:=true; end if;
    elsif depth=1 and left(token,1)='"' and (token::jsonb #>> '{}')='schema_version' then
      awaiting_colon:=true;
    end if;
    if token in ('{','[') then depth:=depth+1; max_depth:=greatest(max_depth,depth);
    elsif token in ('}',']') then depth:=depth-1; end if;
  end loop;
  if is_v2 then
    if max_depth>64 then raise exception 'report_depth_limit' using errcode='22023'; end if;
    if not (raw is json object with unique keys) then
      raise exception 'invalid_or_duplicate_json_keys' using errcode='22023';
    end if;
  end if;
end $$;
revoke all on function public.seosmith_check_raw_report(text) from public,anon,authenticated;

-- The immutable source rows remain untouched. Cache upgraded historical summaries
-- separately, keyed by derivation version, with lifecycle tied to the source row.
create table public.seosmith_summary_cache (
  delivery_id uuid not null references public.seosmith_audits(delivery_id) on delete cascade,
  summary_version integer not null,
  summary jsonb not null,
  primary key(delivery_id,summary_version)
);
alter table public.seosmith_summary_cache enable row level security;
revoke all on public.seosmith_summary_cache from public,anon,authenticated;
grant all on public.seosmith_summary_cache to service_role;
insert into public.seosmith_summary_cache(delivery_id,summary_version,summary)
select delivery_id,4,public.seosmith_summary(report) from public.seosmith_audits
where summary->>'summary_version' is distinct from '4';

create or replace function public.ingest_seosmith_audit(p_token text,p_delivery_id uuid,p_sha256 text,p_report_json text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.seosmith_bindings; w public.websites; r jsonb; old public.seosmith_audits;
begin
  if p_token is null or p_delivery_id is null or p_report_json is null or length(p_token)<32 or octet_length(p_report_json)>16777216 or
     p_sha256 is distinct from encode(sha256(convert_to(p_report_json,'UTF8')),'hex') then
    raise exception 'invalid_delivery' using errcode='22023';
  end if;
  select * into b from public.seosmith_bindings where token_sha256=encode(sha256(convert_to(p_token,'UTF8')),'hex') and enabled for share;
  if not found then raise exception 'invalid_worker' using errcode='42501'; end if;
  select * into strict w from public.websites where id=b.website_id for share;
  perform public.seosmith_check_raw_report(p_report_json);
  r := p_report_json::jsonb;
  if r#>>'{request,request_id}' is distinct from p_delivery_id::text or
     r#>>'{request,website_id}' is distinct from b.website_id::text or
     r#>>'{request,binding_generation}' is distinct from b.generation::text or
     split_part(split_part(r#>>'{request,url}','://',2),'/',1) is distinct from w.fqdn or
     coalesce(r->>'outcome','') not in ('completed','partial','cancelled','failed') or
     jsonb_typeof(r->'pages') is distinct from 'array' or jsonb_typeof(r->'findings') is distinct from 'array' then
    raise exception 'invalid_binding_or_report' using errcode='22023';
  end if;
  perform public.seosmith_summary(r);
  -- Serialize duplicate deliveries across transactions; acknowledge only identical content.
  perform pg_advisory_xact_lock(hashtextextended(p_delivery_id::text,0));
  select * into old from public.seosmith_audits where delivery_id=p_delivery_id;
  if found then
    if old.sha256<>p_sha256 or old.website_id<>b.website_id then raise exception 'delivery_conflict' using errcode='23505'; end if;
  else
    insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json)
      values(p_delivery_id,b.website_id,w.fqdn,b.generation,p_sha256,r,p_report_json);
  end if;
  return jsonb_build_object('delivery_id',p_delivery_id,'sha256',p_sha256,'accepted',true);
end $$;

create or replace function public.import_seosmith_audit(p_website_id uuid,p_report_json text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; r jsonb; rid uuid; sha text; old public.seosmith_audits;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid() for share;
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if p_report_json is null or octet_length(p_report_json)>16777216 then raise exception 'report_limit' using errcode='22023'; end if;
  perform public.seosmith_check_raw_report(p_report_json);
  r:=p_report_json::jsonb;
  if coalesce(r#>>'{request,url}','') !~ '^https?://' or split_part(split_part(r#>>'{request,url}','://',2),'/',1) is distinct from w.fqdn then raise exception 'hostname_mismatch' using errcode='22023'; end if;
  perform public.seosmith_summary(r);
  rid:=(r#>>'{request,request_id}')::uuid;
  if rid is null then raise exception 'missing_request_id' using errcode='22023'; end if;
  sha:=encode(sha256(convert_to(p_report_json,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(rid::text,0));
  select * into old from public.seosmith_audits where delivery_id=rid;
  if found then
    if old.sha256<>sha or old.website_id<>w.id then raise exception 'delivery_conflict' using errcode='23505'; end if;
  else
    insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,ingestion_source,raw_report_json)
      values(rid,w.id,w.fqdn,coalesce((r#>>'{request,binding_generation}')::bigint,1),sha,r,'import',p_report_json);
  end if;
  -- Original bytes/IDs remain intact. The explicit owned target maps local-only IDs.
  return jsonb_build_object('delivery_id',rid,'sha256',sha,'accepted',true);
end $$;
revoke all on function public.import_seosmith_audit(uuid,text) from public;
grant execute on function public.import_seosmith_audit(uuid,text) to authenticated;


create or replace function public.seosmith_audit_history(p_website_id uuid,p_limit integer default 50,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; rows jsonb; more boolean; last_row jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 or (p_before is null)<>(p_before_id is null) then raise exception 'invalid_cursor_or_limit' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.scan_at desc,a.delivery_id desc),'[]'::jsonb) into rows from
    (select audit.delivery_id,audit.scan_at,audit.received_at,audit.ingestion_source,case when audit.summary->>'summary_version'='4' then audit.summary else cache.summary end as summary from public.seosmith_audits audit left join public.seosmith_summary_cache cache on cache.delivery_id=audit.delivery_id and cache.summary_version=4 where audit.website_id=w.id and audit.fqdn=w.fqdn and (p_before is null or (audit.scan_at,audit.delivery_id)<(p_before,p_before_id)) order by audit.scan_at desc,audit.delivery_id desc limit p_limit+1) a;
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
  select jsonb_build_object('delivery_id',audit.delivery_id,'scan_at',audit.scan_at,'received_at',audit.received_at,'ingestion_source',audit.ingestion_source,'summary',case when audit.summary->>'summary_version'='4' then audit.summary else cache.summary end,'report',audit.report,'report_json',audit.raw_report_json) into result from public.seosmith_audits audit left join public.seosmith_summary_cache cache on cache.delivery_id=audit.delivery_id and cache.summary_version=4 where audit.website_id=w.id and audit.fqdn=w.fqdn and audit.delivery_id=p_delivery_id;
  return result;
end $$;
revoke all on function public.seosmith_audit_detail(uuid,uuid) from public;
grant execute on function public.seosmith_audit_detail(uuid,uuid) to authenticated;
