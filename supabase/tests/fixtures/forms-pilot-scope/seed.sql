-- Disposable synthetic fixture only; never run on hosted databases.
do $$ begin if current_setting('forms.pilot_fixture',true) is distinct from 'disposable' then raise exception 'fixture_only'; end if; end $$;
insert into auth.users values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into public.websites(id,owner_id,fqdn) values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','example.com'),('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','other.example.com');
insert into public.website_forms(id,website_id,form_key,name,fields,active) values ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000003','quote','Quote','[{"key":"name","label":"Name","kind":"text","required":false,"max_length":100}]',true);
insert into public.website_form_hosts(id,website_id,hostname,challenge_hash,verified_at) values ('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000003','example.com','hash',now());
insert into public.website_form_origins values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000006');
insert into public.forms_pilot_approved_sites values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001');
