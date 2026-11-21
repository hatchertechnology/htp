-- TEST ONLY: arithmetic invariants. This does NOT reconstruct omitted states.
create or replace function public.seosmith_candidate_coverage_arithmetic(r jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare rows jsonb:=r#>'{policy_guidance,candidate,coverage}'; row jsonb; k text; expected bigint; total bigint; observed bigint;
begin
 if jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows)<>13 then raise exception 'invalid_coverage' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(rows) x group by x->>'category',x->>'rule_id' having count(*)>1) then raise exception 'invalid_coverage' using errcode='22023'; end if;
 for row in select value from jsonb_array_elements(rows) loop
  foreach k in array array['candidates','emitted','omitted'] loop
   if jsonb_typeof(row->k) is distinct from 'number' or row->>k !~ '^(0|[1-9][0-9]*)$' or length(row->>k)>9 then raise exception 'invalid_coverage' using errcode='22023'; end if;
  end loop;
  expected:=(row->>'candidates')::bigint;
  if (row->>'emitted')::bigint+(row->>'omitted')::bigint<>expected then raise exception 'invalid_coverage' using errcode='22023'; end if;
  select count(*) into observed from jsonb_array_elements(r#>'{policy_guidance,candidate,records}') e where e->>'category'=row->>'category' and e->>'rule_id'=row->>'rule_id';
  if observed<>(row->>'emitted')::bigint then raise exception 'invalid_coverage' using errcode='22023'; end if;
  foreach k in array array['eligibility_counts','attempt_counts','outcomes','unknown_reasons'] loop
   if jsonb_typeof(row->k) is distinct from 'object' or exists(select 1 from jsonb_each(row->k) x where jsonb_typeof(x.value) is distinct from 'number' or x.value::text !~ '^(0|[1-9][0-9]*)$' or length(x.value::text)>9) then raise exception 'invalid_coverage' using errcode='22023'; end if;
   select coalesce(sum(value::text::bigint),0) into total from jsonb_each(row->k);
   if (k='unknown_reasons' and total<>coalesce((row#>>'{outcomes,unknown}')::bigint,0)) or (k<>'unknown_reasons' and total<>expected) then raise exception 'invalid_coverage' using errcode='22023'; end if;
  end loop;
 end loop;
end $$;
