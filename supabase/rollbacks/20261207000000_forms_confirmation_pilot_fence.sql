-- Source only. Disable confirmation traffic before restoring legacy behavior.
-- Preserve function identity and dependencies; reapply forward migration to restore fence.
begin;
-- Expected owner and direct ACL are pinned to the reviewed postgres-owned contract.
-- Abort rather than repair drift or silently discard a concurrent source/security change.
do $guard$
declare target oid := to_regprocedure('public.confirm_form_recipient(uuid,text)');
begin
  if not exists (
    select 1 from pg_proc p where p.oid=target
      and p.proowner='postgres'::regrole and p.prosecdef
      and p.proconfig = array['search_path=""']::text[]
      and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='66d2ad5a4d8d9ade7f9bf3c5747fd17e24ad148242ecae65c76cf3f729de4abf'
      and p.prokind='f' and p.prorettype='boolean'::regtype
      and p.prolang=(select oid from pg_language where lanname='plpgsql')
  ) then raise exception 'forms_confirmation_function_drift'; end if;
  -- Exact ACL: only owner and service_role EXECUTE, both granted by postgres,
  -- neither with grant option. Also rejects PUBLIC, extra roles and missing grants.
  if (select count(*) from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=target) <> 2
    or exists (
      select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.oid=target and (a.grantor <> 'postgres'::regrole
        or a.grantee not in ('postgres'::regrole,'service_role'::regrole)
        or a.privilege_type <> 'EXECUTE' or a.is_grantable)
    ) then raise exception 'forms_confirmation_acl_drift'; end if;
  if pg_has_role('anon','postgres','MEMBER')
    or pg_has_role('authenticated','postgres','MEMBER')
    or pg_has_role('service_role','postgres','MEMBER') then
    raise exception 'forms_confirmation_owner_membership_drift';
  end if;
end $guard$;
create or replace function public.confirm_form_recipient(p_recipient_id uuid,p_token text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_token !~ '^[0-9a-f]{64}$' then return false; end if;
  update public.website_form_recipients set verified_at=now() where id=p_recipient_id and enabled and verified_at is null and challenge_expires_at>now() and challenge_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  return found;
end $$;
revoke all on function public.confirm_form_recipient(uuid,text) from public,anon,authenticated;
grant execute on function public.confirm_form_recipient(uuid,text) to service_role;
commit;
