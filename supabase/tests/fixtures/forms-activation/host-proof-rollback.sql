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
begin
  if has_function_privilege('anon','public.begin_form_host_verification(uuid,text)','execute') or has_function_privilege('anon','public.form_host_challenge(uuid)','execute') or has_function_privilege('authenticated','public.begin_form_host_verification(uuid,text)','execute') or has_function_privilege('authenticated','public.form_host_challenge(uuid)','execute') then raise exception 'host_revoke_mismatch'; end if;
end $verify$;
commit;
