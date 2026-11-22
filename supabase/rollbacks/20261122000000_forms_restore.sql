-- Re-enable database privileges after the cause of a forms disable is resolved.
-- This restores ALL listed grants, including management/status, not only host proof.
-- Never run while any independent grant hold remains in force. Restore functions
-- and scheduler only after all grant and database checks pass.
begin;
-- Refuse to re-open the pre-quota challenge RPC during staged rollout.
-- Operators must independently verify the reviewed migration and grants.
do $$
begin
  if to_regclass('public.website_form_host_challenge_windows') is null
    or position('form_host_rate_limited' in pg_catalog.pg_get_functiondef('public.begin_form_host_verification(uuid,text)'::regprocedure)) = 0 then
    raise exception 'forms_host_challenge_quota_required' using errcode='55000';
  end if;
end $$;
grant execute on function public.charge_form_ingress(uuid) to service_role;
grant execute on function public.accept_website_form(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.website_form_origin_allowed(uuid,text) to service_role;
grant execute on function public.begin_form_host_verification(uuid,text) to authenticated;
grant execute on function public.form_host_challenge(uuid) to authenticated;
grant execute on function public.complete_form_host_verification(uuid,text) to service_role;
grant execute on function public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[]) to authenticated;
grant execute on function public.set_website_form_response_status(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.delete_website_form_response(uuid,uuid,uuid) to authenticated;
grant execute on function public.request_form_recipient(uuid,uuid,text) to authenticated;
grant execute on function public.disable_form_recipient(uuid,uuid,uuid) to authenticated;
grant execute on function public.confirm_form_recipient(uuid,text) to service_role;
grant execute on function public.claim_form_delivery() to service_role;
grant execute on function public.finish_form_delivery(uuid,uuid,text) to service_role;
grant execute on function public.retry_form_delivery(uuid,uuid,uuid) to authenticated;
grant execute on function public.charge_form_client(text) to service_role;
commit;
