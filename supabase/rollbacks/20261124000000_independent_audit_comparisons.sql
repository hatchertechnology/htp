-- Stop imports first and export retained evidence before executing this destructive rollback.
drop function if exists public.independent_comparison_history(uuid,timestamptz,uuid);
drop function if exists public.save_independent_comparison(uuid,uuid,uuid,boolean);
drop table if exists public.independent_audit_comparisons;
drop function if exists public.independent_audit_history(uuid,uuid,timestamptz,uuid);
drop function if exists public.import_independent_audit(uuid,text,text,jsonb);
drop table if exists public.independent_audit_imports;
drop function if exists public.validate_independent_csv(text);
