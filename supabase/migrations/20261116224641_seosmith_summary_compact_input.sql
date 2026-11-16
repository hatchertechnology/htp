create or replace function public.seosmith_summary(r jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare summary jsonb; compact jsonb; c jsonb := r->'evidence_contract';
begin
  if r->'schema_version'='1'::jsonb then
    if r ? 'evidence_contract' then raise exception 'unexpected_evidence_contract' using errcode='22023'; end if;
    summary := public.seosmith_legacy_summary(r);
    return summary || jsonb_build_object('summary_version',4,'evidence_contract_version',null,
      'evaluation_coverage_complete',null,'evidence_state','legacy_unknown');
  elsif r->'schema_version'='2'::jsonb then
    -- Only these root fields are consulted by the legacy and evidence validators.
    -- Preserve absence separately from JSON null and retain complete field values.
    select jsonb_object_agg(k, r->k) into compact
      from unnest(array['schema_version','pages','findings','request','outcome',
        'started_at','finished_at','engine_version','ruleset_version','stop_reason',
        'coverage_complete','evidence_contract']) k where r ? k;
    summary := public.seosmith_legacy_summary(jsonb_set(compact,'{schema_version}','1'::jsonb));
    perform public.seosmith_validate_evidence(compact);
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
