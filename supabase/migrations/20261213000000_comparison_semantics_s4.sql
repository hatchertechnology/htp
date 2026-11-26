-- Comparison semantics s15-metadata-2 (SEOsmith schema 4 evidence contract).
-- Widens independent_audit_comparisons.semantics to ('s15-metadata-1','s15-metadata-2')
-- and makes save_independent_comparison record 's15-metadata-2' for new comparisons.
-- Existing s15-metadata-1 rows stay valid and replay with their pinned semantics.
-- Forward-only: the widened check is harmless, and the R2 rollback is to revoke the
-- comparison grants and delete the approval row, not to undo this migration.
-- Grants, the held ACLs and the pilot gate are untouched: create or replace keeps the
-- function ACL, and the guard below proves it did not change.
begin;

-- Refuse source or security-configuration drift before replacing the function.
do $guard$
declare func oid; r text; member_name text; expected_def text;
begin
  func := to_regprocedure('public.save_independent_comparison(uuid,uuid,uuid,boolean)');
  if func is null or not exists (select 1 from pg_proc p where p.oid=func and p.prosecdef
    and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='bb24e6601c600c291538f173161a4db40b328a2d676bcd07fb3d2a0d6dd8fe0b'
    and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=', 'search_path=""'))) then
    raise exception 'comparison_semantics_function_drift';
  end if;
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_proc p where p.oid=func and pg_has_role(r,p.proowner,'MEMBER')) then raise exception 'comparison_semantics_owner_membership_drift'; end if;
  end loop;
  if to_regclass('public.comparison_pilot_approved_sites') is null or to_regprocedure('public.comparison_pilot_site_allowed(uuid)') is null then
    raise exception 'comparison_semantics_pilot_gate_missing';
  end if;
  select pg_get_constraintdef(c.oid) into expected_def from pg_constraint c
    where c.conrelid='public.independent_audit_comparisons'::regclass and c.conname='independent_audit_comparisons_semantics_check' and c.contype='c';
  if expected_def is distinct from $$CHECK ((semantics = 's15-metadata-1'::text))$$ then
    raise exception 'comparison_semantics_constraint_drift';
  end if;
  if exists (select 1 from public.independent_audit_comparisons where semantics<>'s15-metadata-1') then
    raise exception 'comparison_semantics_unexpected_rows';
  end if;
end $guard$;

-- Capture the exact ACL so the migration can prove it did not move any grant.
create temporary table comparison_semantics_acl on commit drop as
  select p.oid::regprocedure::text as signature, coalesce(p.proacl::text,'') as acl
  from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in (
    'import_independent_audit','independent_audit_history','save_independent_comparison','independent_comparison_history',
    'independent_comparison_detail','independent_evidence_fingerprint','delete_independent_audit_evidence','delete_comparison_pilot_evidence');

lock table public.independent_audit_comparisons in access exclusive mode;
alter table public.independent_audit_comparisons drop constraint independent_audit_comparisons_semantics_check;
alter table public.independent_audit_comparisons add constraint independent_audit_comparisons_semantics_check
  check (semantics in ('s15-metadata-1','s15-metadata-2'));

create or replace function public.save_independent_comparison(p_website_id uuid,p_import_id uuid,p_delivery_id uuid,p_asserted boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; item public.independent_audit_comparisons;
begin
  if coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  w := public.comparison_pilot_site_allowed(p_website_id);
  if w.id is null then raise exception 'forbidden' using errcode='42501'; end if;
  if p_asserted is null or not exists(select 1 from public.independent_audit_imports i join public.seosmith_audits a on a.website_id=i.website_id and a.fqdn=i.fqdn where i.id=p_import_id and i.website_id=w.id and a.delivery_id=p_delivery_id) then
    raise exception 'invalid_comparison' using errcode='22023';
  end if;
  insert into public.independent_audit_comparisons(website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted)
  select w.id,i.fqdn,p_import_id,p_delivery_id,'s15-metadata-2',p_asserted from public.independent_audit_imports i where i.id=p_import_id returning * into item;
  return to_jsonb(item);
end $$;

-- Prove the replacement kept its security shape and moved no grant.
do $verify$
declare func oid; changed text;
begin
  func := to_regprocedure('public.save_independent_comparison(uuid,uuid,uuid,boolean)');
  if func is null or not exists (select 1 from pg_proc p where p.oid=func and p.prosecdef
    and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=', 'search_path=""'))
    and p.prosrc like '%public.comparison_pilot_site_allowed(p_website_id)%'
    and p.prosrc not like '%from public.websites%'
    and p.prosrc like '%''s15-metadata-2''%' and p.prosrc not like '%''s15-metadata-1''%') then
    raise exception 'comparison_semantics_function_binding_drift';
  end if;
  select string_agg(a.signature,',') into changed from comparison_semantics_acl a
    join pg_proc p on p.oid=a.signature::regprocedure where coalesce(p.proacl::text,'') is distinct from a.acl;
  if changed is not null then raise exception 'comparison_semantics_acl_drift: %', changed; end if;
end $verify$;

commit;
