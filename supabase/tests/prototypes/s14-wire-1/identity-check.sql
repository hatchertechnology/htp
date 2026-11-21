-- TEST ONLY: identity and duplicate checks, not full source or rule validation.
create or replace function public.seosmith_candidate_identity_check(r jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare rows jsonb:=r#>'{policy_guidance,candidate,records}';
begin
 if jsonb_typeof(r->'pages') is distinct from 'array' or jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows)>512 then raise exception 'invalid_identity' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(r->'pages') p group by p->>'url',coalesce(p->>'is_resource','false') having count(*)>1) then raise exception 'duplicate_entity' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(rows) e group by e->>'record_id' having count(*)>1) then raise exception 'duplicate_record' using errcode='22023'; end if;
 if exists(
  with entities as (select 'sha256:'||encode(sha256(convert_to('seosmith-entity-v1'||chr(10)||case when p->>'is_resource'='true' then 'resource' else 'page' end||chr(10)||(p->>'url'),'UTF8')),'hex') as id from jsonb_array_elements(r->'pages') p),
  records as (select e from jsonb_array_elements(rows) e)
  select 1 from records left join entities on entities.id=e->>'entity_id'
  where entities.id is null or exists(select 1 from unnest(array['record_id','category','rule_id','rule_version','entity_id','discriminator','policy_ref']) k where jsonb_typeof(e->k) is distinct from 'string' or octet_length(e->>k) not between 1 and 256) or e->>'policy_ref' is distinct from r#>>'{policy_guidance,candidate,policy_digest}' or
   e->>'record_id' is distinct from ('sha256:'||encode(sha256(convert_to('seosmith-record-v1'||chr(10)||(e->>'category')||chr(10)||(e->>'rule_id')||chr(10)||(e->>'rule_version')||chr(10)||(e->>'entity_id')||chr(10)||(e->>'discriminator'),'UTF8')),'hex'))
 ) then raise exception 'invalid_identity' using errcode='22023'; end if;
end $$;
