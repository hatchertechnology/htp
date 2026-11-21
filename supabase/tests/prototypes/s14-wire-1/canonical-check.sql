-- TEST ONLY: canonical JSON experiment. Additional Unicode/boundary vectors needed.
create or replace function public.seosmith_candidate_canonical(v jsonb, d integer default 1) returns text
language plpgsql immutable set search_path='' as $$
declare result text; kind text:=jsonb_typeof(v);
begin
 if d>64 and kind in ('object','array') then raise exception 'policy_depth_limit' using errcode='22023'; end if;
 if kind='object' then
  select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.seosmith_candidate_canonical(value,d+1),',' order by convert_to(key,'UTF8')),'')||'}' into result from jsonb_each(v);
  return result;
 elsif kind='array' then
  select '['||coalesce(string_agg(public.seosmith_candidate_canonical(value,d+1),',' order by ord),'')||']' into result from jsonb_array_elements(v) with ordinality as x(value,ord);
  return result;
 elsif kind='number' then
  result:=v::text;
  if result !~ '^-?(0|[1-9][0-9]*)$' or result='-0' or length(result)>17 or result::numeric < -9007199254740991 or result::numeric > 9007199254740991 then raise exception 'invalid_canonical_number' using errcode='22023'; end if;
  return result;
 elsif kind in ('string','boolean','null') then return v::text;
 end if;
 raise exception 'invalid_canonical_value' using errcode='22023';
end $$;
-- Scan the embedded raw string before asking JSONB to parse nested containers.
create or replace function public.seosmith_candidate_policy_depth_check(raw text) returns void
language plpgsql immutable set search_path='' as $$
declare part text[]; token text; depth integer:=0; inside boolean:=false; escaped boolean:=false;
begin
 if raw is null or octet_length(raw)>65536 then raise exception 'invalid_policy_json' using errcode='22023'; end if;
 for part in select regexp_matches(raw, $tok$["\\{}\[\]]|[^"\\{}\[\]]+$tok$, 'g') loop
  token:=part[1];
  if inside then
   if escaped then escaped:=false;
   elsif token=chr(92) then escaped:=true;
   elsif token='"' then inside:=false;
   end if;
  elsif token='"' then inside:=true;
  elsif token in ('{','[') then depth:=depth+1; if depth>64 then raise exception 'policy_depth_limit' using errcode='22023'; end if;
  elsif token in ('}',']') then depth:=depth-1;
  end if;
 end loop;
end $$;
create or replace function public.seosmith_candidate_policy_raw_preflight(raw text) returns void
language plpgsql immutable set search_path='' as $$
begin
 perform public.seosmith_candidate_policy_depth_check(raw);
 if not (raw is json object with unique keys) then raise exception 'invalid_policy_json' using errcode='22023'; end if;
end $$;
create or replace function public.seosmith_candidate_canonical_check(raw text) returns void
language plpgsql immutable set search_path='' as $$
begin
 perform public.seosmith_candidate_policy_raw_preflight(raw);
 if public.seosmith_candidate_canonical(raw::jsonb) is distinct from raw then raise exception 'noncanonical_policy' using errcode='22023'; end if;
end $$;
