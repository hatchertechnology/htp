\timing on
set statement_timeout='8s';
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-0000000000aa","is_anonymous":false}',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000aa',false);
set role authenticated;
begin; select public.import_seosmith_audit('00000000-0000-4000-8000-000000000002',replace(raw,'f38e9469-3cdf-41fd-bbbd-f8ba1b77c9c6','00000000-0000-4000-8000-000000000091')) from dry.payloads where name='tokenimport'; rollback;
begin; select public.import_seosmith_audit('00000000-0000-4000-8000-000000000002',replace(raw,'f38e9469-3cdf-41fd-bbbd-f8ba1b77c9c6','00000000-0000-4000-8000-000000000092')) from dry.payloads where name='tokenimport'; rollback;
begin; select public.import_seosmith_audit('00000000-0000-4000-8000-000000000002',replace(raw,'f38e9469-3cdf-41fd-bbbd-f8ba1b77c9c6','00000000-0000-4000-8000-000000000093')) from dry.payloads where name='tokenimport'; rollback;
