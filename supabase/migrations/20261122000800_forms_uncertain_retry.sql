-- An owner may explicitly resend an uncertain response notification after
-- checking for delivery. Verification tokens are discarded on uncertainty;
-- a fresh verification request is required instead.
create or replace function public.retry_form_delivery(p_website_id uuid,p_form_id uuid,p_job_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites w join public.website_forms f on f.website_id=w.id where w.id=p_website_id and f.id=p_form_id and w.owner_id=(select auth.uid())) then raise exception 'Delivery not found' using errcode='42501'; end if;
  update public.website_form_delivery_jobs j set state='pending',updated_at=now() from public.website_form_recipients r
    where j.id=p_job_id and j.recipient_id=r.id and r.website_id=p_website_id and r.form_id=p_form_id and r.enabled and (j.state='failed' or (j.state='uncertain' and j.kind='response')) and (j.kind='response' or (j.secret_token is not null and r.challenge_expires_at>now()));
  return found;
end $$;
