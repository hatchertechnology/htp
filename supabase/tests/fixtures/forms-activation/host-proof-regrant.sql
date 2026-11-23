-- DISPOSABLE FIXTURE ONLY. Not a hosted runner or authorization to activate.
-- It grants exactly the two owner RPCs needed to start/read a DNS proof.
-- It does not prove target function hashes, ledger, inherited roles, locks,
-- pilot identity, quota deployment, or concurrent privileged activity.
begin;
do $check$
declare name text;
begin
  if current_setting('forms.activation_fixture',true) is distinct from 'disposable' then raise exception 'fixture_only'; end if;
  if to_regclass('public.website_form_host_challenge_windows') is null
     or position('form_host_rate_limited' in pg_get_functiondef('public.begin_form_host_verification(uuid,text)'::regprocedure))=0 then raise exception 'quota_required'; end if;
  foreach name in array array[
    'public.begin_form_host_verification(uuid,text)', 'public.form_host_challenge(uuid)',
    'public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[])', 'public.set_website_form_response_status(uuid,uuid,uuid,text)',
    'public.request_form_recipient(uuid,uuid,text)', 'public.disable_form_recipient(uuid,uuid,uuid)',
    'public.retry_form_delivery(uuid,uuid,uuid)', 'public.delete_website_form_response(uuid,uuid,uuid)'
  ] loop
    if to_regprocedure(name) is null or has_function_privilege('anon',name,'execute') or has_function_privilege('authenticated',name,'execute') then raise exception 'held_privilege_drift'; end if;
  end loop;
  if not has_function_privilege('service_role','public.complete_form_host_verification(uuid,text)','execute') then raise exception 'service_completion_missing'; end if;
end $check$;
grant execute on function public.begin_form_host_verification(uuid,text), public.form_host_challenge(uuid) to authenticated;
do $verify$
begin
  if not has_function_privilege('authenticated','public.begin_form_host_verification(uuid,text)','execute') or not has_function_privilege('authenticated','public.form_host_challenge(uuid)','execute')
    or has_function_privilege('anon','public.begin_form_host_verification(uuid,text)','execute') or has_function_privilege('anon','public.form_host_challenge(uuid)','execute') then raise exception 'host_grant_mismatch'; end if;
end $verify$;
commit;
