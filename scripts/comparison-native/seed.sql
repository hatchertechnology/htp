insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into public.websites(id,owner_id,fqdn) values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','fixture.invalid');
insert into public.independent_audit_imports(id,website_id,fqdn,format,source_text,source_sha256,metadata) values ('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000003','fixture.invalid','controlled-csv-v1', convert_from(decode(:'csv','base64'),'UTF8'),encode(sha256(decode(:'csv','base64')),'hex'),'{"filename":"s15-controlled.csv"}');
insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json) values ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003','fixture.invalid',1,encode(sha256(convert_to(:'report','UTF8')),'hex'), :'report'::jsonb, :'report');
insert into public.independent_audit_comparisons(id,website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted) values ('00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000003','fixture.invalid','00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000004','s15-metadata-1',true);
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.independent_audit_history(uuid,uuid,timestamptz,uuid), public.independent_comparison_history(uuid,timestamptz,uuid), public.independent_comparison_detail(uuid,uuid) to authenticated;
-- A separate bounded history exercises the first 100-item page without changing the UI fixture.
insert into public.websites(id,owner_id,fqdn) values ('00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-000000000001','bounded.fixture.invalid');
insert into public.independent_audit_imports(website_id,fqdn,format,source_text,source_sha256,metadata)
select '00000000-0000-0000-0000-000000000008','bounded.fixture.invalid','controlled-csv-v1',convert_from(decode(:'csv','base64'),'UTF8'),encode(sha256(decode(:'csv','base64')),'hex'),jsonb_build_object('filename','bounded.csv','note',repeat('x',1024)) from generate_series(1,101);
