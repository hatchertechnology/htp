-- Immutable audit documents plus small indexed summaries for historical charts.
alter table public.seosmith_audits add column raw_report_json text;
alter table public.seosmith_audits add column summary jsonb not null default '{}'::jsonb;
alter table public.seosmith_audits add column scan_at timestamptz;
alter table public.seosmith_audits add column ingestion_source text not null default 'worker' check (ingestion_source in ('worker','import'));

create function public.seosmith_summary(r jsonb) returns jsonb language plpgsql stable set search_path='' as $$
declare counts jsonb; rules jsonb; pages jsonb; finished timestamptz; started timestamptz;
begin
  if jsonb_typeof(r) is distinct from 'object' or r->>'schema_version' is distinct from '1' or
     jsonb_typeof(r->'pages') is distinct from 'array' or jsonb_typeof(r->'findings') is distinct from 'array' or
     coalesce(r->>'outcome','') not in ('completed','partial','failed','cancelled') then
    raise exception 'invalid_seosmith_report' using errcode='22023';
  end if;
  if jsonb_array_length(r->'pages')>20000 or jsonb_array_length(r->'findings')>200000 or
     exists(select 1 from jsonb_array_elements(r->'findings') f where jsonb_typeof(f) is distinct from 'object' or coalesce(f->>'severity','') not in ('critical','alert','warning') or coalesce(f->>'rule','')='' or coalesce(f->>'url','')='') then
    raise exception 'invalid_seosmith_findings' using errcode='22023';
  end if;
  started := nullif(r->>'started_at','')::timestamptz;
  finished := nullif(r->>'finished_at','')::timestamptz;
  if finished < started then raise exception 'invalid_scan_dates' using errcode='22023'; end if;
  select jsonb_build_object('critical',count(*) filter(where f->>'severity'='critical'),'alert',count(*) filter(where f->>'severity'='alert'),'warning',count(*) filter(where f->>'severity'='warning')) into counts from jsonb_array_elements(r->'findings') f;
  select coalesce(jsonb_object_agg(rule,n),'{}'::jsonb) into rules from (select f->>'rule' rule,count(*) n from jsonb_array_elements(r->'findings') f group by f->>'rule') q;
  select jsonb_build_object('checked',count(*),'html',count(*) filter(where p->>'status'='200' and p->>'content_type' ilike 'text/html%'),'images',count(*) filter(where p->>'content_type' ilike 'image/%'),'http_errors',count(*) filter(where p->>'status' ~ '^[45][0-9]{2}$'),'fetch_errors',count(*) filter(where p->>'error' is not null),'blocked',count(*) filter(where p->>'blocked_by_robots'='true')) into pages from jsonb_array_elements(r->'pages') p;
  return jsonb_build_object('schema_version',r->'schema_version','engine_version',r->>'engine_version','ruleset_version',r->>'ruleset_version',
    'started_at',started,'finished_at',finished,'outcome',r->>'outcome','stop_reason',r->>'stop_reason',
    'coverage_complete',coalesce(r->>'coverage_complete'='true' and r->>'outcome'='completed',false),
    'pages',pages,'findings',jsonb_array_length(r->'findings'),'severities',counts,'rules',rules,
    'comparison_key',encode(sha256(convert_to(jsonb_build_object('request',((r->'request') - 'request_id'::text - 'website_id'::text - 'binding_generation'::text),'engine',r->'engine_version','ruleset',r->'ruleset_version')::text,'UTF8')),'hex'));
end $$;
revoke all on function public.seosmith_summary(jsonb) from public,anon,authenticated;

update public.seosmith_audits set summary=public.seosmith_summary(report),scan_at=coalesce(nullif(report->>'finished_at','')::timestamptz,received_at);
create index seosmith_audits_scan_history on public.seosmith_audits(website_id,scan_at desc,delivery_id desc);
create function public.seosmith_prepare_audit() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' then raise exception 'audit_is_immutable' using errcode='22023'; end if;
  new.summary:=public.seosmith_summary(new.report);
  new.scan_at:=coalesce(nullif(new.report->>'finished_at','')::timestamptz,new.received_at);
  return new;
end $$;
revoke all on function public.seosmith_prepare_audit() from public,anon,authenticated;
create trigger seosmith_immutable_audit before insert or update on public.seosmith_audits for each row execute function public.seosmith_prepare_audit();

create function public.import_seosmith_audit(p_website_id uuid,p_report_json text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; r jsonb; rid uuid; sha text; old public.seosmith_audits;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid() for share;
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if p_report_json is null or octet_length(p_report_json)>16777216 then raise exception 'report_limit' using errcode='22023'; end if;
  r:=p_report_json::jsonb;
  if coalesce(r#>>'{request,url}','') !~ '^https?://' or split_part(split_part(r#>>'{request,url}','://',2),'/',1) is distinct from w.fqdn then raise exception 'hostname_mismatch' using errcode='22023'; end if;
  perform public.seosmith_summary(r);
  rid:=(r#>>'{request,request_id}')::uuid;
  if rid is null then raise exception 'missing_request_id' using errcode='22023'; end if;
  sha:=encode(sha256(convert_to(p_report_json,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(rid::text,0));
  select * into old from public.seosmith_audits where delivery_id=rid;
  if found then
    if old.sha256<>sha or old.website_id<>w.id then raise exception 'delivery_conflict' using errcode='23505'; end if;
  else
    insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,ingestion_source,raw_report_json)
      values(rid,w.id,w.fqdn,coalesce((r#>>'{request,binding_generation}')::bigint,1),sha,r,'import',p_report_json);
  end if;
  -- Original bytes/IDs remain intact. The explicit owned target maps local-only IDs.
  return jsonb_build_object('delivery_id',rid,'sha256',sha,'accepted',true);
end $$;
revoke all on function public.import_seosmith_audit(uuid,text) from public;
grant execute on function public.import_seosmith_audit(uuid,text) to authenticated;

create function public.seosmith_audit_history(p_website_id uuid,p_limit integer default 50,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; rows jsonb; more boolean; last_row jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 or (p_before is null)<>(p_before_id is null) then raise exception 'invalid_cursor_or_limit' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.scan_at desc,a.delivery_id desc),'[]'::jsonb) into rows from
    (select delivery_id,scan_at,received_at,ingestion_source,summary from public.seosmith_audits where website_id=w.id and fqdn=w.fqdn and (p_before is null or (scan_at,delivery_id)<(p_before,p_before_id)) order by scan_at desc,delivery_id desc limit p_limit+1) a;
  more:=jsonb_array_length(rows)>p_limit;
  if more then rows:=rows-p_limit; end if;
  last_row:=rows->(jsonb_array_length(rows)-1);
  return jsonb_build_object('items',rows,'has_more',more,'next_cursor',case when more then jsonb_build_object('before',last_row->>'scan_at','before_id',last_row->>'delivery_id') else null end);
end $$;
revoke all on function public.seosmith_audit_history(uuid,integer,timestamptz,uuid) from public;
grant execute on function public.seosmith_audit_history(uuid,integer,timestamptz,uuid) to authenticated;

create function public.seosmith_audit_detail(p_website_id uuid,p_delivery_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; result jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  select jsonb_build_object('delivery_id',delivery_id,'scan_at',scan_at,'received_at',received_at,'ingestion_source',ingestion_source,'summary',summary,'report',report,'report_json',raw_report_json) into result from public.seosmith_audits where website_id=w.id and fqdn=w.fqdn and delivery_id=p_delivery_id;
  return result;
end $$;
revoke all on function public.seosmith_audit_detail(uuid,uuid) from public;
grant execute on function public.seosmith_audit_detail(uuid,uuid) to authenticated;

create or replace function public.ingest_seosmith_audit(p_token text,p_delivery_id uuid,p_sha256 text,p_report_json text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.seosmith_bindings; w public.websites; r jsonb; old public.seosmith_audits;
begin
  if length(p_token)<32 or octet_length(p_report_json)>16777216 or
     p_sha256 is distinct from encode(sha256(convert_to(p_report_json,'UTF8')),'hex') then
    raise exception 'invalid_delivery' using errcode='22023';
  end if;
  select * into b from public.seosmith_bindings where token_sha256=encode(sha256(convert_to(p_token,'UTF8')),'hex') and enabled for share;
  if not found then raise exception 'invalid_worker' using errcode='42501'; end if;
  select * into strict w from public.websites where id=b.website_id for share;
  r := p_report_json::jsonb;
  if r->>'schema_version' is distinct from '1' or r#>>'{request,request_id}' is distinct from p_delivery_id::text or
     r#>>'{request,website_id}' is distinct from b.website_id::text or
     r#>>'{request,binding_generation}' is distinct from b.generation::text or
     split_part(split_part(r#>>'{request,url}','://',2),'/',1) is distinct from w.fqdn or
     coalesce(r->>'outcome','') not in ('completed','partial','cancelled','failed') or
     jsonb_typeof(r->'pages') is distinct from 'array' or jsonb_typeof(r->'findings') is distinct from 'array' then
    raise exception 'invalid_binding_or_report' using errcode='22023';
  end if;
  if jsonb_array_length(r->'pages')>20000 or jsonb_array_length(r->'findings')>200000 then
    raise exception 'report_limit' using errcode='22023';
  end if;
  -- Serialize duplicate deliveries across transactions; acknowledge only identical content.
  perform pg_advisory_xact_lock(hashtextextended(p_delivery_id::text,0));
  select * into old from public.seosmith_audits where delivery_id=p_delivery_id;
  if found then
    if old.sha256<>p_sha256 or old.website_id<>b.website_id then raise exception 'delivery_conflict' using errcode='23505'; end if;
  else
    insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json)
      values(p_delivery_id,b.website_id,w.fqdn,b.generation,p_sha256,r,p_report_json);
  end if;
  return jsonb_build_object('delivery_id',p_delivery_id,'sha256',p_sha256,'accepted',true);
end $$;
