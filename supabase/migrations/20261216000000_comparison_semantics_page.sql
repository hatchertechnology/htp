-- Explicit version preserves the four-argument RPC for clients already open at rollout.
begin;
lock table public.independent_audit_comparisons in access exclusive mode;
do $guard$
declare f oid := to_regprocedure('public.save_independent_comparison(uuid,uuid,uuid,boolean)'); d text;
begin
  if f is null or not exists (select 1 from pg_proc p where p.oid=f and p.prosecdef
    and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='59c990b5081e71a31db4967a79dc5593381a5b6217d2035ecd13e749ac8b64f5'
    and exists(select 1 from unnest(p.proconfig) c where c in ('search_path=', 'search_path=""'))) then
    raise exception 'comparison_page_function_drift';
  end if;
  if exists(select 1 from pg_proc p, unnest(array['anon','authenticated','service_role']) r where p.oid=f and pg_has_role(r,p.proowner,'MEMBER')) then raise exception 'comparison_page_owner_drift'; end if;
  select pg_get_constraintdef(oid) into d from pg_constraint where conrelid='public.independent_audit_comparisons'::regclass and conname='independent_audit_comparisons_semantics_check' and contype='c';
  if d is distinct from $$CHECK ((semantics = ANY (ARRAY['s15-metadata-1'::text, 's15-metadata-2'::text])))$$ then raise exception 'comparison_page_constraint_drift'; end if;
  if to_regprocedure('public.save_independent_comparison_versioned(uuid,uuid,uuid,boolean,text)') is not null then raise exception 'comparison_page_function_exists'; end if;
end $guard$;
alter table public.independent_audit_comparisons drop constraint independent_audit_comparisons_semantics_check;
alter table public.independent_audit_comparisons add constraint independent_audit_comparisons_semantics_check check (semantics in ('s15-metadata-1','s15-metadata-2','s15-metadata-3'));
create function public.save_independent_comparison_versioned(p_website_id uuid,p_import_id uuid,p_delivery_id uuid,p_asserted boolean,p_semantics text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; item public.independent_audit_comparisons;
begin
  if coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  w := public.comparison_pilot_site_allowed(p_website_id);
  if w.id is null then raise exception 'forbidden' using errcode='42501'; end if;
  if p_semantics is distinct from 's15-metadata-3' or p_asserted is null or not exists(select 1 from public.independent_audit_imports i join public.seosmith_audits a on a.website_id=i.website_id and a.fqdn=i.fqdn where i.id=p_import_id and i.website_id=w.id and a.delivery_id=p_delivery_id) then raise exception 'invalid_comparison' using errcode='22023'; end if;
  insert into public.independent_audit_comparisons(website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted)
  select w.id,i.fqdn,p_import_id,p_delivery_id,p_semantics,p_asserted from public.independent_audit_imports i where i.id=p_import_id returning * into item;
  return to_jsonb(item);
end $$;
revoke all on function public.save_independent_comparison_versioned(uuid,uuid,uuid,boolean,text) from public,anon,authenticated,service_role;
do $grant$
begin
  if has_function_privilege('authenticated','public.save_independent_comparison(uuid,uuid,uuid,boolean)','EXECUTE') then
    grant execute on function public.save_independent_comparison_versioned(uuid,uuid,uuid,boolean,text) to authenticated;
  end if;
  if has_function_privilege('anon','public.save_independent_comparison(uuid,uuid,uuid,boolean)','EXECUTE') or has_function_privilege('public','public.save_independent_comparison(uuid,uuid,uuid,boolean)','EXECUTE') then raise exception 'comparison_page_acl_drift'; end if;
end $grant$;
do $verify$
declare old_f oid := to_regprocedure('public.save_independent_comparison(uuid,uuid,uuid,boolean)'); new_f oid := to_regprocedure('public.save_independent_comparison_versioned(uuid,uuid,uuid,boolean,text)');
begin
  if not exists(select 1 from pg_proc p where p.oid=old_f and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='59c990b5081e71a31db4967a79dc5593381a5b6217d2035ecd13e749ac8b64f5')
     or not exists(select 1 from pg_proc p where p.oid=new_f and p.prosecdef and exists(select 1 from unnest(p.proconfig) c where c in ('search_path=', 'search_path=""')))
     or has_function_privilege('anon',new_f,'EXECUTE') or has_function_privilege('public',new_f,'EXECUTE')
     or has_function_privilege('service_role',new_f,'EXECUTE')
     or has_function_privilege('authenticated',old_f,'EXECUTE') is distinct from has_function_privilege('authenticated',new_f,'EXECUTE') then
    raise exception 'comparison_page_postcondition_drift';
  end if;
end $verify$;
commit;
