select version();
do $$
declare r text; f text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
  foreach f in array array['public.seosmith_remediation_list(uuid,uuid,integer,timestamptz,uuid)','public.seosmith_remediation_save(uuid,uuid,integer,jsonb)','public.seosmith_remediation_attempt(uuid,uuid,uuid,text,text)'] loop
   if has_function_privilege(r,f,'execute') then raise exception 'remediation privilege unexpectedly held by %',r; end if;
  end loop;
 end loop;
 foreach f in array array['public.begin_form_host_verification(uuid,text)','public.form_host_challenge(uuid)','public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[])','public.set_website_form_response_status(uuid,uuid,uuid,text)','public.request_form_recipient(uuid,uuid,text)','public.disable_form_recipient(uuid,uuid,uuid)','public.retry_form_delivery(uuid,uuid,uuid)','public.delete_website_form_response(uuid,uuid,uuid)'] loop
  foreach r in array array['anon','authenticated'] loop
   if has_function_privilege(r,f,'execute') then raise exception 'forms privilege unexpectedly held by %',r; end if;
  end loop;
 end loop;
 if has_function_privilege('service_role','public.forms_pilot_site_allowed(uuid)','execute') then raise exception 'forms pilot helper exposed'; end if;
end $$;
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into public.websites(id,owner_id,fqdn) values('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','example.com'),('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000002','other.example.com');
insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report) values ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003','example.com',1,repeat('a',64),'{"schema_version":1,"findings":[{"key":"original"}]}'::jsonb),('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000005','other.example.com',1,repeat('b',64),'{"schema_version":1,"findings":[{"key":"other"}]}'::jsonb);
-- Explicit synthetic authorization for behavior tests only.
grant execute on function public.seosmith_remediation_list(uuid,uuid,integer,timestamptz,uuid),public.seosmith_remediation_save(uuid,uuid,integer,jsonb),public.seosmith_remediation_attempt(uuid,uuid,uuid,text,text) to authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","is_anonymous":false}',false);
set role authenticated;
do $$
declare w jsonb; a jsonb;
begin
 begin perform public.seosmith_remediation_save('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000006',0,'{}'); raise exception 'cross-site audit accepted'; exception when invalid_parameter_value then null; end;
 begin perform public.seosmith_remediation_save('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',1,'{}'); raise exception 'invalid index accepted'; exception when invalid_parameter_value then null; end;
 w:=public.seosmith_remediation_save('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',0,'{"status":"done"}');
 if w->>'finding_key'<>'original' or w->>'status'<>'done' then raise exception 'binding failed'; end if;
 begin perform public.seosmith_remediation_attempt('00000000-0000-0000-0000-000000000003',(w->>'id')::uuid,'00000000-0000-0000-0000-000000000006','observed','bad'); raise exception 'cross-site attempt accepted'; exception when invalid_parameter_value then null; end;
 a:=public.seosmith_remediation_attempt('00000000-0000-0000-0000-000000000003',(w->>'id')::uuid,null,'unverified','waiting');
 if a->>'result'<>'unverified' then raise exception 'attempt failed'; end if;
 w:=public.seosmith_remediation_list('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',0,null,null)->0;
 if w->>'status'<>'done' or w->'attempts'->0->>'result'<>'unverified' then raise exception 'workflow conflated with verification'; end if;
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000002","is_anonymous":false}',true);
 begin perform public.seosmith_remediation_list('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',0,null,null); raise exception 'other owner accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin if (select report->'findings'->0->>'key' from public.seosmith_audits where delivery_id='00000000-0000-0000-0000-000000000004') <> 'original' then raise exception 'audit modified'; end if; end $$;
select 'remediation PG17 ordered checks passed' as result;
