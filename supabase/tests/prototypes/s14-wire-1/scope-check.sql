-- TEST ONLY: scope digest and trusted worker binding; imports remain unverified.
create or replace function public.seosmith_candidate_scope_check(r jsonb,p_source text,p_website uuid,p_generation bigint) returns text
language plpgsql immutable set search_path='' as $$
declare w text:=r#>>'{request,website_id}'; g text:=r#>>'{request,binding_generation}'; scope_bytes text; expected text;
begin
 if p_source is null or p_source not in ('worker','import') or w is null or g is null or g !~ '^(0|[1-9][0-9]*)$' or length(g)>16 or g::numeric>9007199254740991 or w !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'invalid_scope' using errcode='22023'; end if;
 scope_bytes:='seosmith-scope-v1'||chr(10)||'website_id='||octet_length(w)||':'||w||chr(10)||'binding_generation='||octet_length(g)||':'||g||chr(10);
 expected:='sha256:'||encode(sha256(convert_to(scope_bytes,'UTF8')),'hex');
 if r#>>'{policy_guidance,candidate,scope_digest}' is distinct from expected then raise exception 'invalid_scope' using errcode='22023'; end if;
 if p_source='worker' then
  if p_website is null or p_generation is null or p_generation<1 or w is distinct from p_website::text or g is distinct from p_generation::text then raise exception 'invalid_worker_scope' using errcode='22023'; end if;
  return 'verified';
 end if;
 return 'unverified';
end $$;
