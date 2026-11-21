-- TEST ONLY: tuple shape check, never sufficient for acceptance by itself.
create or replace function public.seosmith_candidate_state_check(r jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare records jsonb:=r#>'{policy_guidance,candidate,records}'; e jsonb; cat text; eligibility text; attempt text; outcome text; complete boolean;
begin
 if jsonb_typeof(records) is distinct from 'array' then raise exception 'invalid_state' using errcode='22023'; end if;
 for e in select value from jsonb_array_elements(records) loop
  cat:=e->>'category'; eligibility:=e->>'eligibility'; attempt:=e->>'attempt'; outcome:=e->>'outcome'; complete:=attempt='completed';
  if cat is null or cat not in ('advisory','observation','policy_violation') or eligibility is null or attempt is null or outcome is null or not (e ?& array['eligibility','attempt','outcome','actual','source_locator','expected','confidence','reason']) then raise exception 'invalid_state' using errcode='22023'; end if;
  if complete then
   if eligibility<>'eligible' or e->>'actual' is distinct from 'source' or e->>'confidence' is distinct from 'high' or e->'reason' is distinct from 'null'::jsonb or jsonb_typeof(e->'source_locator') is distinct from 'string' then raise exception 'invalid_state' using errcode='22023'; end if;
   if cat='observation' then
    if outcome<>'observed' or e->'expected' is distinct from 'null'::jsonb or not e ? 'observed_fact' then raise exception 'invalid_state' using errcode='22023'; end if;
   elsif cat='advisory' then
    if outcome not in ('advisory_triggered','advisory_not_triggered') or jsonb_typeof(e->'expected') is distinct from 'string' or e ? 'observed_fact' then raise exception 'invalid_state' using errcode='22023'; end if;
   else
    if outcome not in ('violation','no_violation') or jsonb_typeof(e->'expected') is distinct from 'string' or e ? 'observed_fact' then raise exception 'invalid_state' using errcode='22023'; end if;
   end if;
  else
   if attempt<>'not_attempted' or e->>'actual' is distinct from 'unavailable' or e->>'confidence' is distinct from 'unknown' or e->'source_locator' is distinct from 'null'::jsonb or e->'expected' is distinct from 'null'::jsonb or jsonb_typeof(e->'reason') is distinct from 'string' or coalesce(e->>'reason','')='' or e ? 'observed_fact' then raise exception 'invalid_state' using errcode='22023'; end if;
   if not ((eligibility='unknown' and outcome='unknown') or (cat in ('advisory','policy_violation') and eligibility='ineligible' and outcome='not_applicable')) then raise exception 'invalid_state' using errcode='22023'; end if;
  end if;
 end loop;
end $$;
