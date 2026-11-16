\timing on
set statement_timeout='3s'; set role anon;
begin; select public.ingest_seosmith_audit(repeat('x',64),'00000000-0000-4000-8000-000000000101',sha,raw) from dry.worker_cases where n=101; rollback;
begin; select public.ingest_seosmith_audit(repeat('x',64),'00000000-0000-4000-8000-000000000102',sha,raw) from dry.worker_cases where n=102; rollback;
begin; select public.ingest_seosmith_audit(repeat('x',64),'00000000-0000-4000-8000-000000000103',sha,raw) from dry.worker_cases where n=103; rollback;
