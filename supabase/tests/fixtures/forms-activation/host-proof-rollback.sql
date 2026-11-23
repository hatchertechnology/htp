-- DISPOSABLE FIXTURE ONLY. Revoke the same pair; preserve all stored data.
-- Unknown/partially applied production states require independent reconciliation.
begin;
do $check$
begin
  if current_setting('forms.activation_fixture',true) is distinct from 'disposable' then raise exception 'fixture_only'; end if;
  if not has_function_privilege('authenticated','public.begin_form_host_verification(uuid,text)','execute') or not has_function_privilege('authenticated','public.form_host_challenge(uuid)','execute') then raise exception 'host_grant_drift'; end if;
end $check$;
revoke execute on function public.begin_form_host_verification(uuid,text), public.form_host_challenge(uuid) from authenticated;
do $verify$
declare name text;
begin
    if has_function_privilege('anon','public.begin_form_host_verification(uuid,text)','execute') or has_function_privilege('anon','public.form_host_challenge(uuid)','execute') or has_function_privilege('authenticated','public.begin_form_host_verification(uuid,text)','execute') or has_function_privilege('authenticated','public.form_host_challenge(uuid)','execute') then raise exception 'host_revoke_mismatch'; end if;
  foreach name in array array[
    'public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[])', 'public.set_website_form_response_status(uuid,uuid,uuid,text)',
    'public.request_form_recipient(uuid,uuid,text)', 'public.disable_form_recipient(uuid,uuid,uuid)',
    'public.retry_form_delivery(uuid,uuid,uuid)', 'public.delete_website_form_response(uuid,uuid,uuid)'
  ] loop
    if to_regprocedure(name) is null or has_function_privilege('anon',name,'execute') or has_function_privilege('authenticated',name,'execute') then raise exception 'other_hold_drift'; end if;
  end loop;
  if not has_function_privilege('service_role','public.complete_form_host_verification(uuid,text)','execute') then raise exception 'service_completion_missing'; end if;
end $verify$;
commit;
