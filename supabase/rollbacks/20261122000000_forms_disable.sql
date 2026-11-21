-- After disabling the public form Edge Functions and unscheduling
-- htp-form-notifications, disable new management and ingestion. Preserve all
-- tables, responses, proof records, and delivery history for recovery.
begin;
revoke execute on function public.charge_form_ingress(uuid) from service_role;
revoke execute on function public.accept_website_form(uuid,uuid,text,jsonb) from service_role;
revoke execute on function public.website_form_origin_allowed(uuid,text) from service_role;
revoke execute on function public.begin_form_host_verification(uuid,text) from authenticated;
revoke execute on function public.form_host_challenge(uuid) from authenticated;
revoke execute on function public.complete_form_host_verification(uuid,text) from service_role;
revoke execute on function public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[]) from authenticated;
revoke execute on function public.set_website_form_response_status(uuid,uuid,uuid,text) from authenticated;
revoke execute on function public.delete_website_form_response(uuid,uuid,uuid) from authenticated;
revoke execute on function public.request_form_recipient(uuid,uuid,text) from authenticated;
revoke execute on function public.disable_form_recipient(uuid,uuid,uuid) from authenticated;
revoke execute on function public.confirm_form_recipient(uuid,text) from service_role;
revoke execute on function public.claim_form_delivery() from service_role;
revoke execute on function public.finish_form_delivery(uuid,uuid,text) from service_role;
revoke execute on function public.retry_form_delivery(uuid,uuid,uuid) from authenticated;
revoke execute on function public.charge_form_client(text) from service_role;
commit;
