-- S14 wire 2, database half (WP8c-2). Forward-only and INERT while the wire-2 validator
-- revision is disabled: it installs that revision with enabled=false (R6 enables it), the
-- per-revision S01 limits, the evidence_families structure check, the truthful capabilities and
-- a held read RPC. Wire-1 rows, bytes and limits are unchanged. The commit RPC and the replay rule
-- (a committed delivery returns its receipt before any current-state check) are untouched.
-- Design: coordination/plans/wave1-wp8a.md sections 5 and 6 (8c-2). Rollback: the file in
-- supabase/rollbacks/20261215000000_s14_wire2_disable.sql only disables the revision.
begin;

-- 1. Precondition: nothing may have been admitted by a wire-2 revision yet.
do $guard$
begin
  if exists (select 1 from public.seosmith_audits where starts_with(validator_revision,'s14-wire-2/')) then
    raise exception 's14_wire2_rows_exist' using errcode='55000';
  end if;
end $guard$;

-- 2. The v2 receiver revision, DISABLED. Must equal htp_s14_receiver::VALIDATOR_REVISION_V2.
insert into public.seosmith_s14_validators(revision,enabled)
  values ('s14-wire-2/full-population-1/evidence-v1/families-v1',false);

-- 3. The S01 evidence validator takes its limits. Same body as 20261121130000 except for the two
-- limits; the 1-argument form keeps its name, ACL and behaviour (128 observations, 512 evaluations).
create function public.seosmith_validate_evidence(r jsonb,p_max_observations integer,p_max_evaluations integer) returns void
language plpgsql immutable set search_path='' as $$
declare
  c jsonb := r->'evidence_contract'; o jsonb; e jsonb; v jsonb; p jsonb; src jsonb;
  coverage jsonb; policy jsonb; rule_ids jsonb; n integer; observed integer; omitted integer;
  field text; reason text; expected_count integer; actual_count integer; complete boolean; canonical text;
  start_second timestamp; end_second timestamp; start_fraction text; end_fraction text; start_zone text; end_zone text;
begin
  if p_max_observations is null or p_max_evaluations is null or p_max_observations<1 or p_max_evaluations<1 then
    raise exception 'invalid_evidence_limits' using errcode='22023';
  end if;
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
  if jsonb_array_length(c->'observations')>p_max_observations or jsonb_array_length(c->'evaluations')>p_max_evaluations or
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
     length(coalesce(r->>'started_at','')) > 64 or length(coalesce(r->>'finished_at','')) > 64 or
     coalesce(r->>'started_at','') !~ '^\d{4}-\d{2}-\d{2}[Tt]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$' or
     coalesce(r->>'finished_at','') !~ '^\d{4}-\d{2}-\d{2}[Tt]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$' then
    raise exception 'invalid_evidence_interval' using errcode='22023';
  end if;
  -- Explicit application subset: four-digit valid Gregorian dates, 00-23h,
  -- 00-59 minutes/seconds (leap seconds excluded), and total length <=64 bytes.
  if not pg_catalog.pg_input_is_valid(left(r->>'started_at',10),'date') or
     not pg_catalog.pg_input_is_valid(left(r->>'finished_at',10),'date') then
    raise exception 'invalid_evidence_interval' using errcode='22023';
  end if;
  -- Convert whole seconds and explicit offsets manually, because PostgreSQL
  -- rounds fractions and its timezone parser rejects RFC3339 offsets >=16h.
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
  start_fraction := rpad(coalesce(substring(r->>'started_at' from '\.(\d+)'),''),64,'0');
  end_fraction := rpad(coalesce(substring(r->>'finished_at' from '\.(\d+)'),''),64,'0');
  if (start_second,start_fraction collate "C") > (end_second,end_fraction collate "C") then
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
revoke all on function public.seosmith_validate_evidence(jsonb,integer,integer) from public,anon,authenticated,service_role;
create or replace function public.seosmith_validate_evidence(r jsonb) returns void
language sql immutable set search_path='' as $$ select public.seosmith_validate_evidence(r,128,512) $$;

-- 4. Schema-4 insert trigger: limits by revision (wire 1: 128/512, wire 2: 1024/1024) and the
-- evidence_families structure. Otherwise the 20261211000000 body.
create or replace function public.seosmith_prepare_audit() returns trigger
language plpgsql security definer set search_path='' as $$
declare s jsonb; compact jsonb; rawj jsonb; fam jsonb; wire2 boolean; max_obs integer; max_evals integer;
begin
  if tg_op='UPDATE' then raise exception 'audit_is_immutable' using errcode='22023'; end if;
  if new.report->>'schema_version'='4' then
    if new.report->'schema_version' is distinct from '4'::jsonb or new.ingestion_source is distinct from 'worker'
       or new.raw_report_json is null or new.summary_text is null or new.summary_sha256 is null
       or new.validator_revision is null or octet_length(new.raw_report_json)>4952756 then
      raise exception 'invalid_s14_binding' using errcode='22023';
    end if;
    if new.sha256 is distinct from encode(sha256(convert_to(new.raw_report_json,'UTF8')),'hex')
       or new.summary_sha256 is distinct from encode(sha256(convert_to(new.summary_text,'UTF8')),'hex')
       then
      raise exception 'invalid_s14_binding' using errcode='22023';
    end if;
    -- Malformed JSON maps to the documented 22023 codes, never a raw 22P02.
    begin rawj := new.raw_report_json::jsonb;
    exception when data_exception then raise exception 'invalid_s14_binding' using errcode='22023'; end;
    if rawj is distinct from new.report then
      raise exception 'invalid_s14_binding' using errcode='22023';
    end if;
    if octet_length(new.summary_text)>16384 then
      raise exception 'invalid_s14_summary' using errcode='22023';
    end if;
    begin s := new.summary_text::jsonb;
    exception when data_exception then raise exception 'invalid_s14_summary' using errcode='22023'; end;
    if jsonb_typeof(s) is distinct from 'object' or s->'summary_version' is distinct from '5'::jsonb
       or s->'schema_version' is distinct from '4'::jsonb
       or s->'findings' is distinct from to_jsonb(jsonb_array_length(new.report->'findings'))
       or s->>'outcome' is distinct from new.report->>'outcome'
       or s->>'engine_version' is distinct from new.report->>'engine_version'
       or s->>'ruleset_version' is distinct from new.report->>'ruleset_version' then
      raise exception 'invalid_s14_summary' using errcode='22023';
    end if;
    -- Wire 2 (s14-wire-2/...) widens the S01 limits and carries evidence_families; wire 1 is unchanged.
    wire2 := starts_with(new.validator_revision,'s14-wire-2/');
    max_obs := case when wire2 then 1024 else 128 end;
    max_evals := case when wire2 then 1024 else 512 end;
    -- FOR SHARE: a concurrent disable waits for this insert, so no row is admitted
    -- against a revision whose disable has already committed.
    perform 1 from public.seosmith_s14_validators v where v.revision=new.validator_revision and v.enabled for share;
    if not found then
      raise exception 'validator_disabled' using errcode='55000';
    end if;
    -- Families are present if and only if the row was admitted by a wire-2 validator. Only the
    -- cheap structure is checked here (the receiver validates the content): an object, version 1
    -- and at most 786,432 COMPACT bytes (jsonb::text is not compact, so the helper is used).
    if wire2 then
      fam := new.report->'evidence_families';
      if jsonb_typeof(fam) is distinct from 'object' or fam->'version' is distinct from '1'::jsonb
         or public.seosmith_compact_json_size(fam)>786432 then
        raise exception 'evidence_families_invalid' using errcode='22023';
      end if;
    elsif new.report ? 'evidence_families' then
      raise exception 'evidence_families_invalid' using errcode='22023';
    end if;
    if new.report ? 'evidence_contract' then
      -- The S01 validator only knows schema 2; it consults only these root fields.
      select jsonb_set(jsonb_object_agg(k, new.report->k),'{schema_version}','2'::jsonb) into compact
        from unnest(array['schema_version','pages','findings','request','outcome',
          'started_at','finished_at','engine_version','ruleset_version','stop_reason',
          'coverage_complete','evidence_contract']) k where new.report ? k;
      begin
        perform public.seosmith_validate_evidence(compact,max_obs,max_evals);
      exception when data_exception then
        raise exception 'evidence_invalid' using errcode='22023', detail=sqlerrm;
      end;
    end if;
    new.summary := s;
    begin new.scan_at := coalesce(nullif(new.report->>'finished_at','')::timestamptz,new.received_at);
    exception when data_exception then raise exception 'invalid_s14_binding' using errcode='22023'; end;
    return new;
  end if;
  new.summary:=public.seosmith_summary(new.report);
  new.scan_at:=coalesce(nullif(new.report->>'finished_at','')::timestamptz,new.received_at);
  return new;
end $$;
revoke all on function public.seosmith_prepare_audit() from public,anon,authenticated;

-- 5. Capabilities. The v1 keys are unchanged (older clients read them). wire-2 appears in
-- policy_wire_contracts and wire_limits only while a wire-2 validator is enabled, so the function
-- reads the table: it is STABLE (was IMMUTABLE) and SECURITY DEFINER (the table is not API-readable).
create or replace function public.seosmith_receiver_capabilities() returns jsonb
language sql stable security definer set search_path='' as $$
  with w as (select exists(select 1 from public.seosmith_s14_validators where enabled and starts_with(revision,'s14-wire-2/')) v2)
  select jsonb_build_object('receiver','htp','schema_versions',jsonb_build_array(1,2,4),
    'policy_wire_contracts',case when w.v2 then jsonb_build_array('s14-wire-1','s14-wire-2') else jsonb_build_array('s14-wire-1') end,
    'evidence_contract_versions',jsonb_build_array(1),'max_evidence_observations',128,
    'max_evaluations',512,'max_evidence_contract_bytes',1048576,
    'max_schema2_nesting_depth',64,'schema2_unique_object_keys',true,
    'max_report_bytes',4952756,'max_pages',20000,'max_resources',20000,
    'max_observations',40000,'max_findings',400000,
    'exact_bytes',true,'receipt_fields',jsonb_build_array('delivery_id','sha256','accepted'),
    'wire_limits',jsonb_build_object('s14-wire-1',jsonb_build_object('max_evidence_observations',128,'max_evaluations',512,'max_manifest_bytes',262144))
      || case when w.v2 then jsonb_build_object('s14-wire-2',jsonb_build_object('max_evidence_observations',1024,'max_evaluations',1024,
        'max_manifest_bytes',16384,'manifest_form','digest','evidence_families_versions',jsonb_build_array(1),'max_evidence_families_bytes',786432))
        else '{}'::jsonb end)
  from w
$$;
revoke all on function public.seosmith_receiver_capabilities() from public;
grant execute on function public.seosmith_receiver_capabilities() to anon,authenticated;

-- 6. Read path for families. Owner-only like seosmith_audit_detail (forbidden otherwise, which the
-- API maps to 404); an unknown delivery of an owned website returns null. HELD: revoked from every
-- API role until R6's grant-families.sql.
create function public.seosmith_audit_evidence_families(p_website_id uuid,p_delivery_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w public.websites; a public.seosmith_audits;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  select * into a from public.seosmith_audits where website_id=w.id and fqdn=w.fqdn and delivery_id=p_delivery_id;
  if not found then return null; end if;
  return jsonb_build_object('delivery_id',a.delivery_id,
    'wire_contract_version',coalesce(a.summary->>'wire_contract_version',a.report#>>'{policy_guidance,version}'),
    'evidence_families',a.report->'evidence_families',
    'reason',case when a.report ? 'evidence_families' then null else 'not_collected' end);
end $$;
revoke all on function public.seosmith_audit_evidence_families(uuid,uuid) from public,anon,authenticated,service_role;

commit;
