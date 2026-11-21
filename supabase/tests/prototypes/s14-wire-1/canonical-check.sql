-- TEST ONLY: canonical JSON experiment. Additional Unicode/boundary vectors needed.
create or replace function public.seosmith_candidate_canonical(v jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare result text; kind text:=jsonb_typeof(v);
begin
 if kind='object' then
  select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.seosmith_candidate_canonical(value),',' order by convert_to(key,'UTF8')),'')||'}' into result from jsonb_each(v);
  return result;
 elsif kind='array' then
  select '['||coalesce(string_agg(public.seosmith_candidate_canonical(value),',' order by ord),'')||']' into result from jsonb_array_elements(v) with ordinality as x(value,ord);
  return result;
 elsif kind='number' then
  result:=v::text;
  if result !~ '^-?(0|[1-9][0-9]*)$' or result='-0' or length(result)>17 or result::numeric < -9007199254740991 or result::numeric > 9007199254740991 then raise exception 'invalid_canonical_number' using errcode='22023'; end if;
  return result;
 elsif kind in ('string','boolean','null') then return v::text;
 end if;
 raise exception 'invalid_canonical_value' using errcode='22023';
end $$;
create or replace function public.seosmith_candidate_canonical_check(raw text) returns void
language plpgsql immutable set search_path='' as $$
begin
 if raw is null or octet_length(raw)>65536 or not (raw is json object with unique keys) then raise exception 'invalid_policy_json' using errcode='22023'; end if;
 if public.seosmith_candidate_canonical(raw::jsonb) is distinct from raw then raise exception 'noncanonical_policy' using errcode='22023'; end if;
end $$;
