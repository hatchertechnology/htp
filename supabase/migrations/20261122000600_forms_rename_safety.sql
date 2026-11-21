-- A website rename cannot silently keep collecting for a formerly associated
-- domain. Invalidate proofs and pause forms while preserving every response.
create function public.pause_forms_on_website_rename() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.fqdn is distinct from old.fqdn then
    update public.website_forms set active=false where website_id=new.id;
    update public.website_form_hosts set verified_at=null where website_id=new.id;
  end if;
  return new;
end $$;
revoke all on function public.pause_forms_on_website_rename() from public,anon,authenticated;
create trigger pause_forms_on_website_rename after update of fqdn on public.websites for each row execute function public.pause_forms_on_website_rename();

-- Explicit website deletion may remove empty form configuration, but never
-- collected responses or jobs currently being sent.
create function public.guard_website_form_deletion() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.website_form_responses where website_id=old.id) then raise exception 'Delete or export collected form responses before deleting this website' using errcode='23503'; end if;
  perform 1 from public.website_form_delivery_jobs j join public.website_form_recipients r on r.id=j.recipient_id where r.website_id=old.id for update of j;
  if exists(select 1 from public.website_form_delivery_jobs j join public.website_form_recipients r on r.id=j.recipient_id where r.website_id=old.id and j.state='sending') then raise exception 'A form notification is currently sending' using errcode='23503'; end if;
  delete from public.website_form_delivery_jobs j using public.website_form_recipients r where j.recipient_id=r.id and r.website_id=old.id;
  delete from public.website_form_recipients where website_id=old.id;
  delete from public.website_form_origins where website_id=old.id;
  delete from public.website_form_submission_tombstones t using public.website_forms f where t.form_id=f.id and f.website_id=old.id;
  delete from public.website_forms where website_id=old.id;
  delete from public.website_form_hosts where website_id=old.id;
  return old;
end $$;
revoke all on function public.guard_website_form_deletion() from public,anon,authenticated;
create trigger guard_website_form_deletion before delete on public.websites for each row execute function public.guard_website_form_deletion();
