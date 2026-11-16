\timing on
select dry.timeit('perf','retry 19k','anon',$q$select public.ingest_seosmith_audit(repeat('x',64),(raw::jsonb#>>'{request,request_id}')::uuid,encode(sha256(convert_to(raw,'UTF8')),'hex'),raw)::text from dry.payloads where name='legacy-pages-8m'$q$);
insert into dry.payloads select 'perf-new-8m',jsonb_set(raw::jsonb,'{request,request_id}',to_jsonb('00000000-0000-4000-8000-000000000099'::text))::text from dry.payloads where name='legacy-pages-8m';
select dry.timeit('perf','new 19k','anon',$q$select public.ingest_seosmith_audit(repeat('x',64),(raw::jsonb#>>'{request,request_id}')::uuid,encode(sha256(convert_to(raw,'UTF8')),'hex'),raw)::text from dry.payloads where name='perf-new-8m'$q$);
select dry.timeit('perf','cache derive five','supabase_admin',$q$select count(public.seosmith_cached_legacy_summary(report,summary))::text from public.seosmith_audits where delivery_id in (select (raw::jsonb#>>'{request,request_id}')::uuid from dry.payloads where name like 'legacy-pages-%' or name='legacy-pad-16m')$q$);
select label,ms,ok,detail from dry.results where phase='perf';
select a.raw_report_json=d.raw and a.sha256=encode(sha256(convert_to(d.raw,'UTF8')),'hex') as exact_bytes from public.seosmith_audits a join dry.payloads d on a.delivery_id=(d.raw::jsonb#>>'{request,request_id}')::uuid where d.name='perf-new-8m';
