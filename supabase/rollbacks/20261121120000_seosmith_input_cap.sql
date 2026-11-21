-- Revert the input-cap migration without altering stored audits.
create or replace function public.seosmith_receiver_capabilities() returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('receiver','htp','schema_versions',jsonb_build_array(1,2),
    'evidence_contract_versions',jsonb_build_array(1),'max_evidence_observations',128,
    'max_evaluations',512,'max_evidence_contract_bytes',1048576,
    'max_schema2_nesting_depth',64,'schema2_unique_object_keys',true,
    'max_report_bytes',16777216,'max_pages',20000,'max_resources',20000,
    'max_observations',40000,'max_findings',400000,
    'exact_bytes',true,'receipt_fields',jsonb_build_array('delivery_id','sha256','accepted'))
$$;
revoke all on function public.seosmith_receiver_capabilities() from public;
grant execute on function public.seosmith_receiver_capabilities() to anon,authenticated;


create or replace function public.ingest_seosmith_audit(p_token text,p_delivery_id uuid,p_sha256 text,p_report_json text)
returns jsonb language plpgsql security definer set search_path = '' set statement_timeout='20s' as $$
declare b public.seosmith_bindings; w public.websites; r jsonb; old public.seosmith_audits;
begin
  if p_token is null or p_delivery_id is null or p_report_json is null or length(p_token)<32 or octet_length(p_report_json)>16777216 or
     p_sha256 is distinct from encode(sha256(convert_to(p_report_json,'UTF8')),'hex') then
    raise exception 'invalid_delivery' using errcode='22023';
  end if;
  select * into b from public.seosmith_bindings where token_sha256=encode(sha256(convert_to(p_token,'UTF8')),'hex') and enabled for share;
  if not found then raise exception 'invalid_worker' using errcode='42501'; end if;
  select * into strict w from public.websites where id=b.website_id for share;
  perform public.seosmith_check_raw_report(p_report_json);
  r := p_report_json::jsonb;
  if r#>>'{request,request_id}' is distinct from p_delivery_id::text or
     r#>>'{request,website_id}' is distinct from b.website_id::text or
     r#>>'{request,binding_generation}' is distinct from b.generation::text or
     split_part(split_part(r#>>'{request,url}','://',2),'/',1) is distinct from w.fqdn or
     coalesce(r->>'outcome','') not in ('completed','partial','cancelled','failed') or
     jsonb_typeof(r->'pages') is distinct from 'array' or jsonb_typeof(r->'findings') is distinct from 'array' then
    raise exception 'invalid_binding_or_report' using errcode='22023';
  end if;
  perform public.seosmith_summary(r);
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


-- Scoped diagnostic: no stored rows; see benchmark README for limits and rollback.
create or replace function public.import_seosmith_audit(p_website_id uuid,p_report_json text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='20s' as $$
declare w public.websites; r jsonb; rid uuid; sha text; old public.seosmith_audits; headers text; traceparent text; trace_id text;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid() for share;
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  -- Only accept a bounded W3C v00 identifier. Headers can be client-supplied;
  -- this is correlation data, never authorization or evidence of identity.
  headers := current_setting('request.headers', true);
  if headers is not null and length(headers) <= 16384 and pg_catalog.pg_input_is_valid(headers, 'jsonb') then
    traceparent := headers::jsonb ->> 'traceparent';
    if traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
       and substring(traceparent from 4 for 32) <> repeat('0',32)
       and substring(traceparent from 37 for 16) <> repeat('0',16) then
      trace_id := substring(traceparent from 4 for 32);
      perform pg_catalog.set_config('application_name', 'htp-import:' || trace_id, true);
      raise log 'htp_import trace=% phase=entry', trace_id;
    end if;
  end if;
  if p_report_json is null or octet_length(p_report_json)>16777216 then raise exception 'report_limit' using errcode='22023'; end if;
  perform public.seosmith_check_raw_report(p_report_json);
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
  if trace_id is not null then raise log 'htp_import trace=% phase=complete', trace_id; end if;
  return jsonb_build_object('delivery_id',rid,'sha256',sha,'accepted',true);
exception
  when query_canceled then
    if trace_id is not null then raise log 'htp_import trace=% phase=canceled', trace_id; end if;
    raise;
  when others then
    if trace_id is not null then raise log 'htp_import trace=% phase=error sqlstate=%', trace_id, SQLSTATE; end if;
    raise;
end $$;
