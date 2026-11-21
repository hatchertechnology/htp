#!/usr/bin/env bash
# Isolated, synthetic PostgreSQL 17 benchmark. No hosted database is contacted.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
NAME="htp-lifecycle-bench-$$"
IMAGE=${LIFECYCLE_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.11.0.004}
trap 'podman rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
podman run -d --rm --name "$NAME" --memory 4g --shm-size 512m --tmpfs /var/lib/postgresql/data:rw,size=3g -e POSTGRES_PASSWORD=dryrun "$IMAGE" >/dev/null
psql_container() { podman exec -i -e PGPASSWORD=dryrun "$NAME" psql -v ON_ERROR_STOP=1 -q -U supabase_admin -h 127.0.0.1 -d postgres "$@"; }
ready=false
for _ in $(seq 1 60); do if psql_container -Atc 'select 1' >/dev/null 2>&1; then ready=true; break; fi; sleep 1; done
$ready || { echo 'PostgreSQL did not start' >&2; exit 1; }
psql_container <<'SQL'
create or replace function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create or replace function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
create table public.websites(id uuid primary key,owner_id uuid,fqdn text);
create table public.seosmith_audits(delivery_id uuid primary key,website_id uuid,fqdn text,scan_at timestamptz,received_at timestamptz default now(),ingestion_source text,summary jsonb,report jsonb);
create index bench_history on public.seosmith_audits(website_id,scan_at desc,delivery_id desc);
insert into public.websites values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','example.com');
create table public.bench_report(report jsonb);
insert into public.bench_report
with pages as (select jsonb_agg(jsonb_build_object('url','https://example.com/'||n,'status',200,'error',null,'blocked_by_robots',false,'content_type','text/html','title','Page '||n,'description','description','links',(select jsonb_agg(jsonb_build_object('url','https://example.com/'||n||'/'||k,'text',repeat('a',32))) from generate_series(1,40) k),'relationships','[]'::jsonb,'flags','[]'::jsonb,'extraction_truncated',false,'is_resource',false,'body_hash',md5(n::text))) p from generate_series(0,127) n),
obs as (select jsonb_agg(jsonb_build_object('entity_id','sha256:'||lpad(to_hex(n),64,'0'),'source_locator','/pages/'||n,'state','available','unknown_reason',null)) o from generate_series(0,127) n),
findings as (select jsonb_agg(jsonb_build_object('rule','rule_'||(n%4),'url','https://example.com/'||(n%128),'severity','warning','evidence','Synthetic finding '||n)) f from generate_series(0,511) n),
evals as (select jsonb_agg(jsonb_build_object('entity_id','sha256:'||lpad(to_hex(n%128),64,'0'),'rule','rule_'||(n/128),'outcome','fail','eligibility','eligible','attempt','completed','rule_version','r','validator_version','v','confidence','high','source_locator','/findings/'||n,'finding_key',lpad(to_hex(n),64,'0'))) e from generate_series(0,511) n)
select jsonb_build_object('schema_version',2,'engine_version','e','ruleset_version','r','pages',pages.p,'findings',findings.f,'evidence_contract',jsonb_build_object('version',1,'policy',jsonb_build_object('signature','digest'),'truncated',false,'omitted_observations',0,'coverage','[]'::jsonb,'observations',obs.o,'evaluations',evals.e)) from pages,obs,findings,evals;
-- Rows were already retained before the index migration.
insert into public.seosmith_audits(delivery_id,website_id,fqdn,scan_at,ingestion_source,summary,report)
select md5(n::text)::uuid,'00000000-0000-0000-0000-000000000001','example.com',now()-n*interval '1 second','import','{"comparison_key":"k"}'::jsonb,report from public.bench_report cross join generate_series(1,100) n;
SQL
psql_container -f - < "$ROOT/supabase/migrations/20261125000000_seosmith_lifecycle_index.sql"
echo '# isolated PostgreSQL 17 synthetic lifecycle benchmark'
psql_container <<'SQL'
select version();
select pg_column_size(report) compressed_report_bytes,octet_length(report::text) report_json_bytes from public.bench_report;
\timing on
select public.seosmith_lifecycle_backfill(50) batch1;
select public.seosmith_lifecycle_backfill(50) batch2;
select public.seosmith_lifecycle_backfill(50) remaining;
insert into public.seosmith_audits(delivery_id,website_id,fqdn,scan_at,ingestion_source,summary,report) select md5('new')::uuid,'00000000-0000-0000-0000-000000000001','example.com',now(),'worker','{"comparison_key":"k"}'::jsonb,report from public.bench_report;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000002","is_anonymous":false}',false);
set role authenticated;
select jsonb_array_length(public.seosmith_lifecycle_history('00000000-0000-0000-0000-000000000001','sha256:'||lpad('0',64,'0'),'rule_0',50)->'items') finding_page_rows;
select jsonb_array_length(public.seosmith_url_lifecycle_history('00000000-0000-0000-0000-000000000001','sha256:'||lpad('0',64,'0'),50)->'items') url_page_rows;
reset role;
select pg_size_pretty(pg_total_relation_size('public.seosmith_lifecycle_evaluations')) evaluation_index_size,pg_size_pretty(pg_total_relation_size('public.seosmith_lifecycle_observations')) url_index_size;
SQL
