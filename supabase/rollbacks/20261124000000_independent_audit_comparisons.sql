-- Stop imports, export and verify each owner's evidence, then use the explicit
-- owner deletion workflow. Never drop these tables while they contain data.
begin;
lock table public.independent_audit_imports, public.independent_audit_comparisons in access exclusive mode;
do $$ begin
  if exists(select 1 from public.independent_audit_imports) or exists(select 1 from public.independent_audit_comparisons) then
    raise exception 'independent_evidence_not_empty';
  end if;
end $$;
drop function if exists public.delete_independent_audit_evidence(uuid,text,text);
drop function if exists public.independent_evidence_fingerprint(uuid);
drop function if exists public.independent_comparison_detail(uuid,uuid);
drop function if exists public.independent_comparison_history(uuid,timestamptz,uuid);
drop function if exists public.save_independent_comparison(uuid,uuid,uuid,boolean);
drop table if exists public.independent_audit_comparisons;
drop function if exists public.independent_audit_history(uuid,uuid,timestamptz,uuid);
drop function if exists public.import_independent_audit(uuid,text,text,jsonb);
drop table if exists public.independent_audit_imports;
drop function if exists public.validate_independent_csv(text);
drop function if exists public.reject_independent_evidence_update();
commit;
