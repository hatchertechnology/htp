-- Accept bounded explicit RFC3339 UTC offsets while preserving report bytes.
create or replace function public.seosmith_validate_evidence(r jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare
  c jsonb := r->'evidence_contract'; o jsonb; e jsonb; v jsonb; p jsonb; src jsonb;
  coverage jsonb; policy jsonb; rule_ids jsonb; n integer; observed integer; omitted integer;
  field text; reason text; expected_count integer; actual_count integer; complete boolean; canonical text;
  start_second timestamp; end_second timestamp; start_ns integer; end_ns integer; start_zone text; end_zone text;
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
     coalesce(r->>'started_at','') !~ '^\d{4}-\d{2}-\d{2}[Tt]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$' or
     coalesce(r->>'finished_at','') !~ '^\d{4}-\d{2}-\d{2}[Tt]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$' then
    raise exception 'invalid_evidence_interval' using errcode='22023';
  end if;
  -- Explicit application subset: four-digit valid Gregorian dates, 00-23h,
  -- 00-59 minutes/seconds (leap seconds excluded), and <=9 fractional digits.
  if not pg_catalog.pg_input_is_valid(left(r->>'started_at',10),'date') or
     not pg_catalog.pg_input_is_valid(left(r->>'finished_at',10),'date') then
    raise exception 'invalid_evidence_interval' using errcode='22023';
  end if;
  -- Convert whole seconds and explicit offsets manually, because PostgreSQL
  -- rounds nanoseconds and its timezone parser rejects RFC3339 offsets >=16h.
  start_second := replace(replace(left(r->>'started_at',19),'T',' '),'t',' ')::timestamp;
  end_second := replace(replace(left(r->>'finished_at',19),'T',' '),'t',' ')::timestamp;
  start_zone := right(r->>'started_at',6); end_zone := right(r->>'finished_at',6);
  if right(r->>'started_at',1) not in ('Z','z') then
    start_second := start_second - make_interval(mins => (case left(start_zone,1) when '-' then -1 else 1 end) *
      (substring(start_zone,2,2)::integer * 60 + right(start_zone,2)::integer));
  end if;
  if right(r->>'finished_at',1) not in ('Z','z') then
    end_second := end_second - make_interval(mins => (case left(end_zone,1) when '-' then -1 else 1 end) *
      (substring(end_zone,2,2)::integer * 60 + right(end_zone,2)::integer));
  end if;
  start_ns := rpad(coalesce(substring(r->>'started_at' from '\.(\d{1,9})'),''),9,'0')::integer;
  end_ns := rpad(coalesce(substring(r->>'finished_at' from '\.(\d{1,9})'),''),9,'0')::integer;
  if (start_second,start_ns) > (end_second,end_ns) then
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
