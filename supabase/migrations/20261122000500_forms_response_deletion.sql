-- Serialize with acceptance, preserve only the idempotency digest, and refuse
-- deletion while a notification is actively in flight.
create function public.delete_website_form_response(p_website_id uuid,p_form_id uuid,p_response_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare response public.website_form_responses%rowtype;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites where id=p_website_id and owner_id=(select auth.uid())) then raise exception 'Response not found' using errcode='42501'; end if;
  perform 1 from public.website_forms where id=p_form_id and website_id=p_website_id for update;
  if not found then raise exception 'Response not found' using errcode='42501'; end if;
  select * into response from public.website_form_responses where id=p_response_id and website_id=p_website_id and form_id=p_form_id for update;
  if not found then raise exception 'Response not found' using errcode='42501'; end if;
  perform 1 from public.website_form_delivery_jobs where response_id=p_response_id for update;
  if exists(select 1 from public.website_form_delivery_jobs where response_id=p_response_id and state='sending') then raise exception 'A notification is currently sending; try again later' using errcode='55000'; end if;
  insert into public.website_form_submission_tombstones(form_id,submission_id,value_hash) values(response.form_id,response.submission_id,encode(sha256(convert_to(response.values::text,'UTF8')),'hex')) on conflict do nothing;
  delete from public.website_form_delivery_jobs where response_id=p_response_id;
  delete from public.website_form_responses where id=p_response_id;
  return true;
end $$;
revoke all on function public.delete_website_form_response(uuid,uuid,uuid) from public,anon;
grant execute on function public.delete_website_form_response(uuid,uuid,uuid) to authenticated;
