-- TEST ONLY: emitted edge predicate experiment. This implementation rescans
-- pages per edge, does not reconstruct omitted edges, and is NOT deployable.
create or replace function public.seosmith_candidate_emitted_edges(r jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare e jsonb; src jsonb; link jsonb; target jsonb; pieces text[]; source_ok boolean; target_count integer; reason text; expected text;
begin
 for e in select value from jsonb_array_elements(r#>'{policy_guidance,candidate,records}') where value->>'category'='observation' and value->>'rule_id'='external_link' loop
  pieces:=regexp_match(e->>'context_locator','^/pages/([0-9]+)/links/([0-9]+)$');
  if pieces is null or length(pieces[1])>6 or length(pieces[2])>6 then raise exception 'invalid_edge' using errcode='22023'; end if;
  src:=r->'pages'->(pieces[1]::integer);link:=src->'links'->(pieces[2]::integer);
  if jsonb_typeof(link) is distinct from 'object' or jsonb_typeof(link->'url') is distinct from 'string' then raise exception 'invalid_edge' using errcode='22023'; end if;
  select count(*), (jsonb_agg(p)->0) into target_count,target from jsonb_array_elements(r->'pages') p where p->>'url'=link->>'url';
  if target_count>1 then raise exception 'ambiguous_external_target' using errcode='22023'; end if;
  source_ok:=coalesce(coalesce((src->>'status')::integer between 200 and 299,false) and lower(btrim(split_part(src->>'content_type',';',1))) in ('text/html','application/xhtml+xml','application/vnd.wap.xhtml+xml') and coalesce((src->>'blocked_by_robots')::boolean,true)=false and src->'error'='null'::jsonb and coalesce((src->>'extraction_truncated')::boolean,true)=false,false);
  if not source_ok then reason:='source_unavailable';
  elsif target_count=0 then reason:=case when r#>>'{request,check_external_links}'='true' then 'external_target_not_fetched' else 'external_check_disabled' end;
  elsif jsonb_typeof(target->'status') is distinct from 'number' or target->'error' is distinct from 'null'::jsonb or target->>'blocked_by_robots' is distinct from 'false' then reason:='external_target_unavailable';
  else reason:=null; end if;
  expected:=case when reason is null then 'observed' else 'unknown' end;
  if e->>'outcome' is distinct from expected or e->>'reason' is distinct from reason then raise exception 'invalid_edge_state' using errcode='22023'; end if;
  if reason is null and e->'observed_fact' is distinct from target->'status' then raise exception 'invalid_edge_fact' using errcode='22023'; end if;
 end loop;
end $$;
