-- Full-mode normal-path fixture: models the R2 state, with the pilot approval row and the eight
-- comparison grants, so the authenticated owner can import, read, save and replay. The report is a
-- committed SEOsmith schema-4 fixture. Disposable loopback only.
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into public.websites(id,owner_id,fqdn) values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','independent.example');
insert into public.comparison_pilot_approved_sites(website_id,owner_id) values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001');
grant execute on function public.import_independent_audit(uuid,text,text,jsonb),public.independent_audit_history(uuid,uuid,timestamptz,uuid),public.save_independent_comparison(uuid,uuid,uuid,boolean),public.independent_comparison_history(uuid,timestamptz,uuid),public.independent_comparison_detail(uuid,uuid),public.independent_evidence_fingerprint(uuid),public.delete_independent_audit_evidence(uuid,text,text),public.delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text) to authenticated;
insert into public.independent_audit_imports(id,website_id,fqdn,format,source_text,source_sha256,metadata) values (
  '00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000003','independent.example','controlled-csv-v1',
  convert_from(decode(:'csv','base64'),'UTF8'), encode(sha256(decode(:'csv','base64')),'hex'),
  jsonb_build_object('filename','independent-tool-controlled.csv','provenance',jsonb_build_object(
    'tool','locally generated standalone crawler','version','9.4','scope','https://independent.example/*',
    'configuration','desktop user agent, no JavaScript rendering','exported_at','2026-11-20T09:00:00Z')));
-- A pre-structured import keeps its free-text provenance as a visible legacy note.
insert into public.independent_audit_imports(id,website_id,fqdn,format,source_text,source_sha256,metadata) values (
  '00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-000000000003','independent.example','controlled-csv-v1',
  convert_from(decode(:'csv','base64'),'UTF8'), encode(sha256(decode(:'csv','base64')),'hex'),
  jsonb_build_object('filename','legacy-controlled.csv','provenance','Legacy free-text note: parser and rendering differences not assessed.'));
-- A schema-4 audit as the worker path stores it: raw bytes, summary text and an enabled validator revision.
insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json,ingestion_source,summary_text,summary_sha256,validator_revision)
select '00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003','independent.example',1,
  encode(sha256(convert_to(:'report','UTF8')),'hex'), :'report'::jsonb, :'report','worker', t, encode(sha256(convert_to(t,'UTF8')),'hex'), 's14-wire-1/full-population-1/evidence-v1'
from (select jsonb_build_object('summary_version',5,'schema_version',4,'findings',jsonb_array_length(r->'findings'),'outcome',r->>'outcome','engine_version',r->>'engine_version','ruleset_version',r->>'ruleset_version')::text t
      from (select :'report'::jsonb r) x) y;
insert into public.independent_audit_comparisons(id,website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted) values (
  '00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000003','independent.example',
  '00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000004','s15-metadata-2',true);
-- A schema-1 report for the same site, so the stored s15-metadata-1 comparison replays comparably
-- instead of only carrying its pinned semantics label. Small on purpose: one eligible page.
insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json,ingestion_source)
select '00000000-0000-0000-0000-00000000000e','00000000-0000-0000-0000-000000000003','independent.example',1,
  encode(sha256(convert_to(t,'UTF8')),'hex'), t::jsonb, t, 'worker'
from (select jsonb_build_object('schema_version',1,'engine_version','0.2.0','ruleset_version','2026-11-01.1',
  'outcome','completed','stop_reason','frontier_exhausted','coverage_complete',true,
  'pages',jsonb_build_array(jsonb_build_object('url','https://example.com/','status',200,'content_type','text/html',
    'error',null,'is_resource',false,'blocked_by_robots',false,'flags',jsonb_build_array(),'extraction_truncated',false)),
  'findings',jsonb_build_array(jsonb_build_object('url','https://example.com/','rule','missing_description','severity','alert')))::text t) x;
-- An earlier s15-metadata-1 comparison stays stored and replayable with its pinned semantics and a schema-1 report.
insert into public.independent_audit_comparisons(id,website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted) values (
  '00000000-0000-0000-0000-00000000000d','00000000-0000-0000-0000-000000000003','independent.example',
  '00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-00000000000e','s15-metadata-1',true);
