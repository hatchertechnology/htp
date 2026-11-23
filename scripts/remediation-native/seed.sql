insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into public.websites(id,owner_id,fqdn) values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','example.com');
-- Only this newly created disposable database is authorized for fixture execution.
do $$ declare f text; begin foreach f in array array['public.seosmith_remediation_list(uuid,uuid,integer,timestamptz,uuid)','public.seosmith_remediation_save(uuid,uuid,integer,jsonb)','public.seosmith_remediation_attempt(uuid,uuid,uuid,text,text)'] loop if has_function_privilege('authenticated',f,'execute') then raise exception 'hold missing: %',f; end if; end loop; end $$;
-- Strip unrelated fixture privileges; allow only normal website reads, audit import/history/detail and these work RPCs.
revoke execute on all functions in schema public from public,anon,authenticated;
revoke insert, update, delete on public.websites from authenticated;
grant execute on function public.import_seosmith_audit(uuid,text),public.seosmith_audit_history(uuid,integer,timestamptz,uuid),public.seosmith_audit_detail(uuid,uuid) to authenticated;
grant execute on function public.seosmith_remediation_list(uuid,uuid,integer,timestamptz,uuid),public.seosmith_remediation_save(uuid,uuid,integer,jsonb),public.seosmith_remediation_attempt(uuid,uuid,uuid,text,text) to authenticated;
