-- S14 schema 4, part E-db: evidence in SQL.
-- Evidence validation for schema 4 already runs inside H2's seosmith_prepare_audit
-- (20261211000000), so that function is not replaced here (no double validation).
-- This migration only uses create or replace so that it applies on the prod-order
-- replay (1-45, 51-55, 46-50, 20261211, 20261212) and on a fresh lexical install,
-- and it never edits the uninstalled 46/47 migrations. Existing ACLs are kept.

-- N2: schema-4 lifecycle comparison key, deterministic from stored columns.
-- No API-role EXECUTE (public, anon, authenticated, service_role are all revoked);
-- only the owner and the security-definer index function call it.
create or replace function public.seosmith_s14_comparison_key(a public.seosmith_audits) returns text
language sql immutable set search_path='' as $$
  select encode(sha256(convert_to(
    (a.summary->>'comparison_key') || chr(10) || 'schema:4' || chr(10)
    || (a.report#>>'{evidence_contract,comparison_key}'),'UTF8')),'hex')
$$;
revoke all on function public.seosmith_s14_comparison_key(public.seosmith_audits) from public,anon,authenticated,service_role;

-- Schema 4 with evidence v1 is indexed as indexed_v1; schema 4 without usable
-- evidence is unsupported. The remainder is the installed body.
create or replace function public.seosmith_index_lifecycle(p_delivery_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a public.seosmith_audits; index_state text; ckey text;
begin
  select * into a from public.seosmith_audits where delivery_id=p_delivery_id;
  if not found then return; end if;
  index_state := case when a.report->>'schema_version'='1' then 'legacy'
    when a.report->>'schema_version'='2' and a.report#>>'{evidence_contract,version}'='1' then 'indexed_v1'
    when a.report->>'schema_version'='4' and a.report#>>'{evidence_contract,version}'='1' then 'indexed_v1'
    else 'unsupported' end;
  if a.report->>'schema_version'='4' and index_state='indexed_v1' then
    ckey := public.seosmith_s14_comparison_key(a);
    if ckey is null then index_state := 'unsupported'; end if;
  else
    ckey := a.summary->>'comparison_key';
  end if;
  insert into public.seosmith_lifecycle_indexed(delivery_id,state,schema_version,engine_version,ruleset_version,comparison_key,policy_digest,evidence_truncated,omitted_observations,coverage)
    values(a.delivery_id,index_state,a.report->>'schema_version',
      case when index_state='indexed_v1' then a.report->>'engine_version' end,
      case when index_state='indexed_v1' then a.report->>'ruleset_version' end,
      case when index_state='indexed_v1' then ckey end,
      case when index_state='indexed_v1' then a.report#>>'{evidence_contract,policy,signature}' end,
      case when index_state='indexed_v1' then (a.report#>>'{evidence_contract,truncated}')::boolean end,
      case when index_state='indexed_v1' then (a.report#>>'{evidence_contract,omitted_observations}')::integer end,
      case when index_state='indexed_v1' then a.report#>'{evidence_contract,coverage}' end)
    on conflict (delivery_id) do nothing;
  if not found then return; end if;
  if index_state='indexed_v1' then
    insert into public.seosmith_lifecycle_observations(delivery_id,entity_id,source_locator,state,unknown_reason,property_digests)
      select a.delivery_id,o->>'entity_id',o->>'source_locator',o->>'state',o->>'unknown_reason',
        public.seosmith_url_property_digests(a.report->'pages'->((substring(o->>'source_locator' from '^/pages/([0-9]+)$'))::integer),o->>'state')
      from jsonb_array_elements(a.report#>'{evidence_contract,observations}') o;
    insert into public.seosmith_lifecycle_evaluations(delivery_id,entity_id,rule,evaluation,finding_digest)
      select a.delivery_id,e->>'entity_id',e->>'rule',jsonb_build_object(
        'rule_version',e->'rule_version','validator_version',e->'validator_version',
        'eligibility',e->'eligibility','attempt',e->'attempt','outcome',e->'outcome',
        'unknown_reason',e->'unknown_reason','source_locator',e->'source_locator',
        'finding_key',e->'finding_key','confidence',e->'confidence'),
        case when e->>'outcome'='fail' then encode(sha256(convert_to((a.report->'findings'->((substring(e->>'source_locator' from '^/findings/([0-9]+)$'))::integer))::text,'UTF8')),'hex') end
      from jsonb_array_elements(a.report#>'{evidence_contract,evaluations}') e;
  end if;
end $$;

-- Enqueue: the summary's evidence_contract_version is null for schema 4, so the
-- version comes from report.evidence_contract.version. Schema 2 is unchanged.
create or replace function public.audit_enqueue_receipt() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.ingestion_source='worker'
     and (new.summary->>'schema_version'='2'
          or (new.report->>'schema_version'='4' and new.report#>>'{evidence_contract,version}'='1'))
     and (select enqueue_enabled from public.audit_event_config where singleton) then
    insert into public.audit_event_jobs(delivery_id,website_id,fqdn,generation)
      values(new.delivery_id,new.website_id,new.fqdn,new.generation) on conflict do nothing;
  end if;
  return new;
end $$;

-- N9: only _save checks the schema; _list and _attempt are untouched.
create or replace function public.seosmith_remediation_save(p_website_id uuid,p_delivery_id uuid,p_finding_index integer,p_work jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.websites; a public.seosmith_audits; f jsonb; m public.seosmith_remediation; k text;
begin
 select * into w from public.websites where id=p_website_id and owner_id=auth.uid() for share;
 if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
 select * into a from public.seosmith_audits where delivery_id=p_delivery_id and website_id=w.id and fqdn=w.fqdn for share;
 if not found or coalesce(a.report->>'schema_version','') not in ('1','2','4') or p_finding_index is null or p_finding_index<0 then raise exception 'invalid_audit_or_finding' using errcode='22023'; end if;
 f:=a.report->'findings'->p_finding_index;
 if jsonb_typeof(f) is distinct from 'object' or jsonb_typeof(f->'key') is distinct from 'string' or coalesce(f->>'key','')='' then raise exception 'invalid_audit_or_finding' using errcode='22023'; end if;
 if jsonb_typeof(p_work) is distinct from 'object' or (p_work - array['status','assignee','segments','exception_note','notes','business_exposure','estimated_effort','rationale']) <> '{}'::jsonb then raise exception 'invalid_work' using errcode='22023'; end if;
 if coalesce(p_work->>'status','open') not in ('open','in_progress','done','excepted') or (p_work ? 'segments' and jsonb_typeof(p_work->'segments') <> 'object') then raise exception 'invalid_work' using errcode='22023'; end if;
 for k in select jsonb_object_keys(p_work) loop
   if k <> 'segments' and jsonb_typeof(p_work->k) not in ('string','null') then raise exception 'invalid_work' using errcode='22023'; end if;
   if octet_length(p_work->>k)>4096 then raise exception 'invalid_work' using errcode='22023'; end if;
 end loop;
 if octet_length(coalesce((p_work->'segments')::text,''))>4096 or (coalesce(p_work->'segments','{}'::jsonb) - array['page','template','locale','device','business']) <> '{}'::jsonb then raise exception 'invalid_work' using errcode='22023'; end if;
 for k in select jsonb_object_keys(coalesce(p_work->'segments','{}'::jsonb)) loop
   if jsonb_typeof(p_work->'segments'->k) <> 'string' then raise exception 'invalid_work' using errcode='22023'; end if;
 end loop;
 insert into public.seosmith_remediation(website_id,delivery_id,finding_index,finding_key,status,assignee,segments,exception_note,notes,business_exposure,estimated_effort,rationale)
 values(w.id,a.delivery_id,p_finding_index,f->>'key',coalesce(p_work->>'status','open'),p_work->>'assignee',coalesce(p_work->'segments','{}'::jsonb),p_work->>'exception_note',p_work->>'notes',p_work->>'business_exposure',p_work->>'estimated_effort',p_work->>'rationale')
 on conflict(delivery_id,finding_index) do update set status=excluded.status,assignee=excluded.assignee,segments=excluded.segments,exception_note=excluded.exception_note,notes=excluded.notes,business_exposure=excluded.business_exposure,estimated_effort=excluded.estimated_effort,rationale=excluded.rationale,updated_at=now()
 returning * into m;
 return to_jsonb(m);
end $$;
