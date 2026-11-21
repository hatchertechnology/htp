-- Restore the pre-diagnostic function body and 20s function setting.
create or replace function public.import_seosmith_audit(p_website_id uuid,p_report_json text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='20s' as $$
declare w public.websites; r jsonb; rid uuid; sha text; old public.seosmith_audits;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid() for share;
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
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
  return jsonb_build_object('delivery_id',rid,'sha256',sha,'accepted',true);
end $$;
