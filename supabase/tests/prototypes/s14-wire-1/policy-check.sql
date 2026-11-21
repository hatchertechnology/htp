-- TEST ONLY: partial candidate checks; not a complete S14 validator or migration.
-- Receipt functions must continue to reject schema 4 until all checks exist.
create or replace function public.seosmith_candidate_policy_check(r jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare g jsonb:=r->'policy_guidance'; c jsonb; p jsonb; raw text; k text;
begin
 if r->'schema_version' is distinct from '4'::jsonb or g->>'version' is distinct from 's14-wire-1' or jsonb_typeof(g->'config') is distinct from 'object' then raise exception 'invalid_candidate' using errcode='22023'; end if;
 c:=g->'config';
 if (c - array['title_min','title_max','description_min','description_max','words_min','links_max','require_indexable','forbid_redirects']) <> '{}'::jsonb or not c ?& array['title_min','title_max','description_min','description_max','words_min','links_max','require_indexable','forbid_redirects'] then raise exception 'invalid_config' using errcode='22023'; end if;
 foreach k in array array['title_min','title_max','description_min','description_max','words_min','links_max'] loop
  if jsonb_typeof(c->k) is distinct from 'number' or c->>k !~ '^(0|[1-9][0-9]*)$' or length(c->>k)>7 or (c->>k)::numeric>1000000 then raise exception 'invalid_config' using errcode='22023'; end if;
 end loop;
 foreach k in array array['require_indexable','forbid_redirects'] loop
  if jsonb_typeof(c->k) is distinct from 'boolean' then raise exception 'invalid_config' using errcode='22023'; end if;
 end loop;
 if (c->>'title_min')::integer>(c->>'title_max')::integer or (c->>'description_min')::integer>(c->>'description_max')::integer then raise exception 'invalid_config' using errcode='22023'; end if;
 raw:=g#>>'{candidate,policy_canonical_json}';
 if raw is null or octet_length(raw)>65536 or not (raw is json object with unique keys) then raise exception 'invalid_policy_json' using errcode='22023'; end if;
 if g#>>'{candidate,policy_digest}' is distinct from ('sha256:'||encode(sha256(convert_to(raw,'UTF8')),'hex')) then raise exception 'invalid_policy_digest' using errcode='22023'; end if;
 p:=raw::jsonb;
 if (p - array['catalog_version','collection','engine_version','policy','ruleset_version','schema_version','validator_version','wire_contract_version']) <> '{}'::jsonb or not p ?& array['catalog_version','collection','engine_version','policy','ruleset_version','schema_version','validator_version','wire_contract_version'] or p->>'catalog_version' is distinct from 's14-1' or p->>'validator_version' is distinct from 's14-wire-1' or p->>'wire_contract_version' is distinct from 's14-wire-1' or p->'schema_version' is distinct from '4'::jsonb or p->>'engine_version' is distinct from r->>'engine_version' or p->>'ruleset_version' is distinct from r->>'ruleset_version' or p->'policy' is distinct from c then raise exception 'invalid_policy_binding' using errcode='22023'; end if;
 if p->'collection' is distinct from jsonb_build_object('seed_url',r#>'{request,url}','max_pages',r#>'{request,max_pages}','max_resources',r#>'{request,max_resources}','max_duration_seconds',r#>'{request,max_duration_seconds}','delay_ms',r#>'{request,delay_ms}','check_external_links',r#>'{request,check_external_links}') then raise exception 'invalid_policy_binding' using errcode='22023'; end if;
end $$;
