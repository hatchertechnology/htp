-- Stop HTP_FORMS_CONFIRM_API first. Explicit drop/restore of legacy contract.
-- Drops only this function, never CASCADE; reapply the forward migration to restore the fence.
begin;
drop function public.confirm_form_recipient(uuid,text);
create function public.confirm_form_recipient(p_recipient_id uuid,p_token text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_token !~ '^[0-9a-f]{64}$' then return false; end if;
  update public.website_form_recipients set verified_at=now() where id=p_recipient_id and enabled and verified_at is null and challenge_expires_at>now() and challenge_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  return found;
end $$;
revoke all on function public.confirm_form_recipient(uuid,text) from public,anon,authenticated;
grant execute on function public.confirm_form_recipient(uuid,text) to service_role;
commit;
