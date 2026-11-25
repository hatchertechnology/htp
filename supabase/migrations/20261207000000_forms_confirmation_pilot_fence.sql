-- Source only; no approval rows or owner grants changed.
begin;
-- Abort on source drift rather than overwrite another lane's confirmation changes.
do $guard$
begin
  if not exists (select 1 from pg_proc where oid=to_regprocedure('public.confirm_form_recipient(uuid,text)')
    and prosecdef and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='7bcf213c05b4a8650ade1ae4d7d7eea0469ddc9d44f36115c5ec6ed0a6019c77') then
    raise exception 'forms_confirmation_function_drift';
  end if;
end $guard$;
create or replace function public.confirm_form_recipient(p_recipient_id uuid,p_token text)
returns boolean language plpgsql security definer set search_path='' as $$
declare site uuid;
begin
  if p_token !~ '^[0-9a-f]{64}$' then return false; end if;
  select website_id into site from public.website_form_recipients where id=p_recipient_id;
  if site is null or not public.forms_pilot_site_allowed(site) then return false; end if;
  -- The approval and current website owner remain share-locked until commit.
  update public.website_form_recipients set verified_at=now() where id=p_recipient_id and website_id=site and enabled and verified_at is null and challenge_expires_at>now() and challenge_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  return found;
end $$;
revoke all on function public.confirm_form_recipient(uuid,text) from public,anon,authenticated;
grant execute on function public.confirm_form_recipient(uuid,text) to service_role;
commit;
