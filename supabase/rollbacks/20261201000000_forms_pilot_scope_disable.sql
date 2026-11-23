-- Fail-closed Forms pilot disable. Stop API ingress and coordinate all service
-- callers first. This leaves data, approvals, jobs, existing reads, function
-- bodies and ledger history intact. It is NOT an authorization to re-enable.
begin;
revoke execute on function public.accept_website_form(uuid,uuid,text,jsonb), public.website_form_origin_allowed(uuid,text), public.complete_form_host_verification(uuid,text) from public,anon,authenticated,service_role;
revoke execute on function public.begin_form_host_verification(uuid,text), public.form_host_challenge(uuid), public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[]), public.set_website_form_response_status(uuid,uuid,uuid,text), public.request_form_recipient(uuid,uuid,text), public.disable_form_recipient(uuid,uuid,uuid), public.retry_form_delivery(uuid,uuid,uuid), public.delete_website_form_response(uuid,uuid,uuid) from public,anon,authenticated;
do $holds$
declare r text; member_name text; signature text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    for member_name in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
      foreach signature in array array['public.accept_website_form(uuid,uuid,text,jsonb)','public.website_form_origin_allowed(uuid,text)','public.complete_form_host_verification(uuid,text)'] loop
        if has_function_privilege(member_name,signature,'EXECUTE') then raise exception 'forms_pilot_service_hold_drift'; end if;
      end loop;
    end loop;
  end loop;
  foreach r in array array['anon','authenticated'] loop
    for member_name in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
      foreach signature in array array['public.begin_form_host_verification(uuid,text)','public.form_host_challenge(uuid)','public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[])','public.set_website_form_response_status(uuid,uuid,uuid,text)','public.request_form_recipient(uuid,uuid,text)','public.disable_form_recipient(uuid,uuid,uuid)','public.retry_form_delivery(uuid,uuid,uuid)','public.delete_website_form_response(uuid,uuid,uuid)'] loop
        if has_function_privilege(member_name,signature,'EXECUTE') then raise exception 'forms_pilot_owner_hold_drift'; end if;
      end loop;
    end loop;
  end loop;
end $holds$;
commit;
