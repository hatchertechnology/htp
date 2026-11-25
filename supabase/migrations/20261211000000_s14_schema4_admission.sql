-- S14 schema 4 admission (database half). The HTP API validates the exact report
-- bytes in-process (crates/s14-receiver), then calls commit_seosmith_audit_v4 with
-- the service key. This migration enforces BINDING, not admission: raw bytes,
-- report, summary text, an enabled validator revision and, when present, valid S01
-- evidence are checked in the same transaction. Any service_role writer is trusted.
-- Schemas 1 and 2 and their RPCs are unchanged; schema 4 stays unreachable from
-- the legacy RPCs (seosmith_summary still rejects it).
begin;

-- Precondition: no schema-4 rows exist (the table may hold schema-1/2 rows).
do $guard$
begin
  if exists (select 1 from public.seosmith_audits where report->>'schema_version'='4') then
    raise exception 's14_schema4_rows_exist' using errcode='55000';
  end if;
end $guard$;

create table public.seosmith_s14_validators (
  revision text primary key check (revision ~ '^[A-Za-z0-9._/-]{1,128}$'),
  enabled boolean not null default true
);
alter table public.seosmith_s14_validators enable row level security;
revoke all on public.seosmith_s14_validators from public,anon,authenticated;
grant select,insert,update on public.seosmith_s14_validators to service_role;
-- Must equal htp_s14_receiver::VALIDATOR_REVISION (a receiver test ties them).
insert into public.seosmith_s14_validators(revision,enabled)
  values ('s14-wire-1/full-population-1/evidence-v1',true);

alter table public.seosmith_audits
  add column summary_text text,
  add column summary_sha256 text check (summary_sha256 ~ '^[a-f0-9]{64}$'),
  add column validator_revision text references public.seosmith_s14_validators(revision);
alter table public.seosmith_audits add constraint seosmith_audits_s14_columns check (
  ((report->>'schema_version')='4') = (summary_text is not null)
  and (summary_text is null) = (summary_sha256 is null)
  and (summary_text is null) = (validator_revision is null));

-- Schema-4 branch of the insert trigger. Update stays forbidden. Schemas 1/2 keep
-- the exact previous behaviour. SECURITY DEFINER so the checks read the validator
-- table and evidence validator whatever role performs a direct insert.
create or replace function public.seosmith_prepare_audit() returns trigger
language plpgsql security definer set search_path='' as $$
declare s jsonb; compact jsonb;
begin
  if tg_op='UPDATE' then raise exception 'audit_is_immutable' using errcode='22023'; end if;
  if new.report->>'schema_version'='4' then
    if new.report->'schema_version' is distinct from '4'::jsonb or new.ingestion_source is distinct from 'worker'
       or new.raw_report_json is null or new.summary_text is null or new.summary_sha256 is null
       or new.validator_revision is null or octet_length(new.raw_report_json)>4952756 then
      raise exception 'invalid_s14_binding' using errcode='22023';
    end if;
    if new.sha256 is distinct from encode(sha256(convert_to(new.raw_report_json,'UTF8')),'hex')
       or new.summary_sha256 is distinct from encode(sha256(convert_to(new.summary_text,'UTF8')),'hex')
       or new.raw_report_json::jsonb is distinct from new.report then
      raise exception 'invalid_s14_binding' using errcode='22023';
    end if;
    s := new.summary_text::jsonb;
    if jsonb_typeof(s) is distinct from 'object' or s->'summary_version' is distinct from '5'::jsonb
       or s->'schema_version' is distinct from '4'::jsonb
       or s->'findings' is distinct from to_jsonb(jsonb_array_length(new.report->'findings'))
       or s->>'outcome' is distinct from new.report->>'outcome'
       or s->>'engine_version' is distinct from new.report->>'engine_version'
       or s->>'ruleset_version' is distinct from new.report->>'ruleset_version' then
      raise exception 'invalid_s14_summary' using errcode='22023';
    end if;
    if not exists (select 1 from public.seosmith_s14_validators v where v.revision=new.validator_revision and v.enabled) then
      raise exception 'validator_disabled' using errcode='55000';
    end if;
    if new.report ? 'evidence_contract' then
      -- The S01 validator only knows schema 2; it consults only these root fields.
      select jsonb_set(jsonb_object_agg(k, new.report->k),'{schema_version}','2'::jsonb) into compact
        from unnest(array['schema_version','pages','findings','request','outcome',
          'started_at','finished_at','engine_version','ruleset_version','stop_reason',
          'coverage_complete','evidence_contract']) k where new.report ? k;
      begin
        perform public.seosmith_validate_evidence(compact);
      exception when sqlstate '22023' then
        raise exception 'evidence_invalid' using errcode='22023', detail=sqlerrm;
      end;
    end if;
    new.summary := s;
    new.scan_at := coalesce(nullif(new.report->>'finished_at','')::timestamptz,new.received_at);
    return new;
  end if;
  new.summary:=public.seosmith_summary(new.report);
  new.scan_at:=coalesce(nullif(new.report->>'finished_at','')::timestamptz,new.received_at);
  return new;
end $$;
revoke all on function public.seosmith_prepare_audit() from public,anon,authenticated;

-- The only schema-4 writer. service_role only; a worker token alone cannot write
-- schema 4 through PostgREST. Errors (message / SQLSTATE):
--   report_limit, invalid_delivery, invalid_binding_or_report  22023
--   invalid_worker 42501; delivery_conflict 23505; validator_disabled 55000
--   invalid_s14_binding, invalid_s14_summary, evidence_invalid 22023 (from the trigger)
create function public.commit_seosmith_audit_v4(p_token text,p_delivery_id uuid,p_sha256 text,p_report_json text,p_summary_text text,p_validator_revision text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='20s' as $$
declare b public.seosmith_bindings; w public.websites; r jsonb; old public.seosmith_audits;
begin
  if p_report_json is not null and octet_length(p_report_json)>4952756 then raise exception 'report_limit' using errcode='22023'; end if;
  if p_token is null or p_delivery_id is null or p_report_json is null or p_summary_text is null or p_validator_revision is null
     or length(p_token)<32 or p_sha256 is distinct from encode(sha256(convert_to(p_report_json,'UTF8')),'hex') then
    raise exception 'invalid_delivery' using errcode='22023';
  end if;
  select * into b from public.seosmith_bindings where token_sha256=encode(sha256(convert_to(p_token,'UTF8')),'hex') and enabled for share;
  if not found then raise exception 'invalid_worker' using errcode='42501'; end if;
  select * into strict w from public.websites where id=b.website_id for share;
  r := p_report_json::jsonb;
  if r->'schema_version' is distinct from '4'::jsonb or
     r#>>'{request,request_id}' is distinct from p_delivery_id::text or
     r#>>'{request,website_id}' is distinct from b.website_id::text or
     r#>>'{request,binding_generation}' is distinct from b.generation::text or
     split_part(split_part(r#>>'{request,url}','://',2),'/',1) is distinct from w.fqdn or
     coalesce(r->>'outcome','') not in ('completed','partial','cancelled','failed') or
     jsonb_typeof(r->'pages') is distinct from 'array' or jsonb_typeof(r->'findings') is distinct from 'array' then
    raise exception 'invalid_binding_or_report' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_delivery_id::text,0));
  select * into old from public.seosmith_audits where delivery_id=p_delivery_id;
  if found then
    if old.sha256<>p_sha256 or old.website_id<>b.website_id then raise exception 'delivery_conflict' using errcode='23505'; end if;
  else
    if not exists (select 1 from public.seosmith_s14_validators v where v.revision=p_validator_revision and v.enabled) then
      raise exception 'validator_disabled' using errcode='55000';
    end if;
    insert into public.seosmith_audits(delivery_id,website_id,fqdn,generation,sha256,report,raw_report_json,ingestion_source,summary_text,summary_sha256,validator_revision)
      values(p_delivery_id,b.website_id,w.fqdn,b.generation,p_sha256,r,p_report_json,'worker',p_summary_text,
        encode(sha256(convert_to(p_summary_text,'UTF8')),'hex'),p_validator_revision);
  end if;
  return jsonb_build_object('delivery_id',p_delivery_id,'sha256',p_sha256,'accepted',true);
end $$;
revoke all on function public.commit_seosmith_audit_v4(text,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.commit_seosmith_audit_v4(text,uuid,text,text,text,text) to service_role;

-- Capability: schema 4 and the wire contract (otherwise the 20261121120000 body).
create or replace function public.seosmith_receiver_capabilities() returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('receiver','htp','schema_versions',jsonb_build_array(1,2,4),
    'policy_wire_contracts',jsonb_build_array('s14-wire-1'),
    'evidence_contract_versions',jsonb_build_array(1),'max_evidence_observations',128,
    'max_evaluations',512,'max_evidence_contract_bytes',1048576,
    'max_schema2_nesting_depth',64,'schema2_unique_object_keys',true,
    'max_report_bytes',4952756,'max_pages',20000,'max_resources',20000,
    'max_observations',40000,'max_findings',400000,
    'exact_bytes',true,'receipt_fields',jsonb_build_array('delivery_id','sha256','accepted'))
$$;
revoke all on function public.seosmith_receiver_capabilities() from public;
grant execute on function public.seosmith_receiver_capabilities() to anon,authenticated;

-- History: schema-4 rows carry their own summary (version 5), not a cached one.
create or replace function public.seosmith_audit_history(p_website_id uuid,p_limit integer default 50,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; rows jsonb; more boolean; last_row jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if p_limit is null or p_limit<1 or p_limit>100 or (p_before is null)<>(p_before_id is null) then raise exception 'invalid_cursor_or_limit' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.scan_at desc,a.delivery_id desc),'[]'::jsonb) into rows from
    (select audit.delivery_id,audit.scan_at,audit.received_at,audit.ingestion_source,case when audit.summary->>'summary_version' in ('4','5') then audit.summary else cache.summary end as summary from public.seosmith_audits audit left join public.seosmith_summary_cache cache on cache.delivery_id=audit.delivery_id and cache.summary_version=4 where audit.website_id=w.id and audit.fqdn=w.fqdn and (p_before is null or (audit.scan_at,audit.delivery_id)<(p_before,p_before_id)) order by audit.scan_at desc,audit.delivery_id desc limit p_limit+1) a;
  more:=jsonb_array_length(rows)>p_limit;
  if more then rows:=rows-p_limit; end if;
  last_row:=rows->(jsonb_array_length(rows)-1);
  return jsonb_build_object('items',rows,'has_more',more,'next_cursor',case when more then jsonb_build_object('before',last_row->>'scan_at','before_id',last_row->>'delivery_id') else null end);
end $$;
revoke all on function public.seosmith_audit_history(uuid,integer,timestamptz,uuid) from public;
grant execute on function public.seosmith_audit_history(uuid,integer,timestamptz,uuid) to authenticated;

-- Detail: schema-4 rows add the stored summary bytes and the source binding
-- (source_sha256 is the verified row digest; source_bytes the raw UTF-8 length).
create or replace function public.seosmith_audit_detail(p_website_id uuid,p_delivery_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; result jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  select jsonb_build_object('delivery_id',audit.delivery_id,'scan_at',audit.scan_at,'received_at',audit.received_at,'ingestion_source',audit.ingestion_source,'summary',case when audit.summary->>'summary_version' in ('4','5') then audit.summary else cache.summary end,'report',audit.report,'report_json',audit.raw_report_json) ||
    case when audit.summary_text is null then '{}'::jsonb else jsonb_build_object('summary_text',audit.summary_text,'summary_sha256',audit.summary_sha256,'summary_bytes',octet_length(audit.summary_text),'source_sha256',audit.sha256,'source_bytes',octet_length(audit.raw_report_json)) end
    into result from public.seosmith_audits audit left join public.seosmith_summary_cache cache on cache.delivery_id=audit.delivery_id and cache.summary_version=4 where audit.website_id=w.id and audit.fqdn=w.fqdn and audit.delivery_id=p_delivery_id;
  return result;
end $$;
revoke all on function public.seosmith_audit_detail(uuid,uuid) from public;
grant execute on function public.seosmith_audit_detail(uuid,uuid) to authenticated;

commit;
