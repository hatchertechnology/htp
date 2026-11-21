-- Read one immutable delivery by exact URL. This does not infer lifecycle or
-- turn an omitted evaluation into a pass. Cursors are zero-based source ordinals.
create function public.search_crawl_evidence(p_website_id uuid, p_delivery_id uuid, p_url text,
  p_finding_after integer default -1, p_evaluation_after integer default -1, p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='8s' as $$
declare w public.websites; a public.seosmith_audits; entity_ids text[]; f jsonb; e jsonb;
  fn integer; en integer; fmore boolean; emore boolean; entities_truncated boolean; rule_coverage jsonb; observations jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous','true')='false';
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  if p_delivery_id is null or p_url is null or length(p_url)>2048 or p_url='' or
    p_finding_after is null or p_finding_after < -1 or p_evaluation_after is null or p_evaluation_after < -1
    or p_limit is null or p_limit<1 or p_limit>50 then
    raise invalid_parameter_value using message='Invalid crawl evidence request';
  end if;
  select * into a from public.seosmith_audits where website_id=w.id and fqdn=w.fqdn and delivery_id=p_delivery_id;
  if not found then return jsonb_build_object('available',false,'reason','delivery_unavailable','coverage','unknown'); end if;
  -- Only S01 observations resolve authoritative entity IDs. Legacy or omitted
  -- observations remain unknown even if a raw finding is present.
  select array_agg(id order by id) into entity_ids from (
    select distinct obs->>'entity_id' id
    from jsonb_array_elements(case when jsonb_typeof(a.report#>'{evidence_contract,observations}')='array'
      then a.report#>'{evidence_contract,observations}' else '[]'::jsonb end) obs
    where case when obs->>'source_locator' ~ '^/pages/[0-9]{1,5}$'
      then a.report->'pages'->(substring(obs->>'source_locator' from '[0-9]+$')::integer)->>'url'=p_url
      else false end and obs->>'entity_id' is not null
    order by id limit 51) matched;
  entities_truncated:=coalesce(array_length(entity_ids,1),0)>50;
  if entities_truncated then entity_ids:=entity_ids[1:50]; end if;
  select coalesce(jsonb_agg(value order by ord),'[]'::jsonb) into observations from (
    select value,ord from jsonb_array_elements(case when jsonb_typeof(a.report#>'{evidence_contract,observations}')='array'
      then a.report#>'{evidence_contract,observations}' else '[]'::jsonb end) with ordinality o(value,ord)
    where value->>'entity_id'=any(coalesce(entity_ids,array[]::text[]))
      and case when value->>'source_locator' ~ '^/pages/[0-9]{1,5}$'
        then a.report->'pages'->(substring(value->>'source_locator' from '[0-9]+$')::integer)->>'url'=p_url
        else false end and octet_length(value::text)<=32768 order by ord limit 50) observed;
  select coalesce(jsonb_agg(item order by ord),'[]'::jsonb),count(*) into f,fn from (
    select ord, jsonb_build_object('source_locator','/findings/'||(ord-1)::text,
      'finding',case when octet_length(value::text)<=32768 then value else null end,
      'evidence_omitted',octet_length(value::text)>32768) item
    from jsonb_array_elements(coalesce(a.report->'findings','[]'::jsonb)) with ordinality x(value,ord)
    where value->>'url'=p_url and ord-1>p_finding_after order by ord limit p_limit+1) q;
  fmore:=fn>p_limit; if fmore then f:=f-p_limit; end if;
  select coalesce(jsonb_agg(item order by ord),'[]'::jsonb),count(*) into e,en from (
    select ord,jsonb_build_object('evaluation_locator','/evidence_contract/evaluations/'||(ord-1)::text,
      'evaluation',case when octet_length(value::text)<=32768 then value else null end,
      'evidence_omitted',octet_length(value::text)>32768) item
    from jsonb_array_elements(case when jsonb_typeof(a.report#>'{evidence_contract,evaluations}')='array'
      then a.report#>'{evidence_contract,evaluations}' else '[]'::jsonb end) with ordinality x(value,ord)
    where value->>'entity_id'=any(coalesce(entity_ids,array[]::text[])) and ord-1>p_evaluation_after
    order by ord limit p_limit+1) q;
  emore:=en>p_limit; if emore then e:=e-p_limit; end if;
  select coalesce(jsonb_agg(value),'[]'::jsonb) into rule_coverage from (
    select c.value from jsonb_array_elements(case when jsonb_typeof(a.report#>'{evidence_contract,coverage}')='array'
      then a.report#>'{evidence_contract,coverage}' else '[]'::jsonb end) c(value)
    where c.value->>'rule' in (select x->'evaluation'->>'rule' from jsonb_array_elements(e) x)
      and octet_length(c.value::text)<=32768 limit 50) relevant;
  return jsonb_build_object('semantics_version',1,'available',true,'delivery_id',a.delivery_id,
    'scan_at',a.scan_at,'received_at',a.received_at,'ingestion_source',a.ingestion_source,
    'binding_generation',a.generation,'exact_url',p_url,'schema_version',a.report->'schema_version',
    'engine_version',a.report->'engine_version','ruleset_version',a.report->'ruleset_version',
    'policy',a.report#>'{evidence_contract,policy}', 'comparison_key',a.report#>'{evidence_contract,comparison_key}',
    'contract_version',a.report#>'{evidence_contract,version}', 'contract_truncated',a.report#>'{evidence_contract,truncated}',
    'evaluation_coverage_complete',a.report#>'{evidence_contract,evaluation_coverage_complete}', 'entity_ids',coalesce(to_jsonb(entity_ids),'[]'::jsonb),
    'entity_ids_truncated',entities_truncated, 'observations',observations, 'observations_complete',false, 'rule_coverage',rule_coverage,
    'coverage','unknown','coverage_reason','missing_or_omitted_evaluations_are_unknown',
    'findings',f,'evaluations',e,'findings_has_more',fmore,'evaluations_has_more',emore,
    'next_finding_after',case when fmore then substring(f->(p_limit-1)->>'source_locator' from '[0-9]+$')::integer else null end,
    'next_evaluation_after',case when emore then substring(e->(p_limit-1)->>'evaluation_locator' from '[0-9]+$')::integer else null end);
end $$;
revoke all on function public.search_crawl_evidence(uuid,uuid,text,integer,integer,integer) from public,anon;
grant execute on function public.search_crawl_evidence(uuid,uuid,text,integer,integer,integer) to authenticated;
