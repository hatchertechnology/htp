-- Full-mode normal-path fixture: the comparison migration keeps its own grants, so the
-- authenticated role can import, read, save and replay. Disposable loopback only.
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into public.websites(id,owner_id,fqdn) values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','independent.example');
insert into public.independent_audit_imports(id,website_id,fqdn,format,source_text,source_sha256,metadata) values (
  '00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000003','independent.example','controlled-csv-v1',
  convert_from(decode(:'csv','base64'),'UTF8'), encode(sha256(decode(:'csv','base64')),'hex'),
  jsonb_build_object('filename','independent-tool-controlled.csv','provenance',jsonb_build_object(
    'tool','locally generated standalone crawler','version','9.4','scope','https://independent.example/*',
    'configuration','desktop user agent, no JavaScript rendering','exported_at','2026-11-20T09:00:00Z')));
insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json) values (
  '00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003','independent.example',1,
  encode(sha256(convert_to(:'report','UTF8')),'hex'), :'report'::jsonb, :'report');
insert into public.independent_audit_comparisons(id,website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted) values (
  '00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000003','independent.example',
  '00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000004','s15-metadata-1',true);
