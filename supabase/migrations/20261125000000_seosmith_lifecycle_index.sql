-- H03: additive, rebuildable index of explicit S01 evaluations. Original audit
-- bytes and receipts remain authoritative. Existing rows require bounded backfill.
create table public.seosmith_lifecycle_indexed (
  delivery_id uuid primary key references public.seosmith_audits(delivery_id) on delete cascade,
  state text not null check (state in ('indexed_v1','legacy','unsupported')),
  schema_version text, engine_version text, ruleset_version text, comparison_key text, policy_digest text,
  evidence_truncated boolean, omitted_observations integer, coverage jsonb,
  index_version integer not null default 1 check (index_version = 1)
);
create table public.seosmith_lifecycle_evaluations (
  delivery_id uuid not null references public.seosmith_audits(delivery_id) on delete cascade,
  entity_id text not null,
  rule text not null,
  evaluation jsonb not null,
  finding_digest text,
  primary key (delivery_id, entity_id, rule)
);
create table public.seosmith_lifecycle_observations (
  delivery_id uuid not null references public.seosmith_audits(delivery_id) on delete cascade,
  entity_id text not null,
  source_locator text not null,
  state text not null,
  unknown_reason text,
  property_digests jsonb not null,
  primary key (delivery_id,entity_id)
);
create function public.seosmith_url_property_digests(p jsonb, observation_state text) returns jsonb
language sql immutable set search_path='' as $$
  select case when observation_state<>'available' or coalesce(p->>'status','') !~ '^[1-5][0-9]{2}$' or p->>'error' is not null
      or p->>'blocked_by_robots'='true' then '{}'::jsonb else
    coalesce((select jsonb_object_agg(k,encode(sha256(convert_to(v::text,'UTF8')),'hex')) from jsonb_each(p) q(k,v)
      where (k in ('status','content_type','redirect') or
        (k in ('title','description','canonical','header_canonical','robots','language','body_hash','words','dom_nodes','headings','links','images','relationships','alternates','structured_data','open_graph','twitter')
         and p->>'status' ~ '^2[0-9]{2}$' and coalesce(p->>'is_resource','false')='false'
         and lower(btrim(split_part(coalesce(p->>'content_type',''),';',1))) in ('text/html','application/xhtml+xml','application/vnd.wap.xhtml+xml')
         and p ? 'flags' and p ? 'extraction_truncated' and p->>'extraction_truncated'='false'
         and not exists(select 1 from jsonb_array_elements_text(p->'flags') f where f in ('extraction_limit','discovery_limit','legacy_checkpoint_metadata'))))), '{}'::jsonb) end
$$;
revoke all on function public.seosmith_url_property_digests(jsonb,text) from public,anon,authenticated;
alter table public.seosmith_lifecycle_observations enable row level security;
alter table public.seosmith_lifecycle_indexed enable row level security;
alter table public.seosmith_lifecycle_evaluations enable row level security;
revoke all on public.seosmith_lifecycle_indexed, public.seosmith_lifecycle_evaluations, public.seosmith_lifecycle_observations from public,anon,authenticated;
grant select,insert,delete on public.seosmith_lifecycle_indexed, public.seosmith_lifecycle_evaluations, public.seosmith_lifecycle_observations to service_role;

create function public.seosmith_index_lifecycle(p_delivery_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a public.seosmith_audits; index_state text;
begin
  select * into a from public.seosmith_audits where delivery_id=p_delivery_id;
  if not found then return; end if;
  index_state := case when a.report->>'schema_version'='1' then 'legacy'
    when a.report->>'schema_version'='2' and a.report#>>'{evidence_contract,version}'='1' then 'indexed_v1'
    else 'unsupported' end;
  insert into public.seosmith_lifecycle_indexed(delivery_id,state,schema_version,engine_version,ruleset_version,comparison_key,policy_digest,evidence_truncated,omitted_observations,coverage)
    values(a.delivery_id,index_state,a.report->>'schema_version',
      case when index_state='indexed_v1' then a.report->>'engine_version' end,
      case when index_state='indexed_v1' then a.report->>'ruleset_version' end,
      case when index_state='indexed_v1' then a.summary->>'comparison_key' end,
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
revoke all on function public.seosmith_index_lifecycle(uuid) from public,anon,authenticated;

create function public.seosmith_index_lifecycle_trigger() returns trigger language plpgsql security definer set search_path='' as $$
begin perform public.seosmith_index_lifecycle(new.delivery_id); return new; end $$;
revoke all on function public.seosmith_index_lifecycle_trigger() from public,anon,authenticated;
create trigger seosmith_lifecycle_index_after_insert after insert on public.seosmith_audits
for each row execute function public.seosmith_index_lifecycle_trigger();

-- Explicit targeted repair: lock the immutable audit and atomically replace
-- index rows only. The original report and receipt are never updated.
create function public.seosmith_lifecycle_reindex(p_delivery_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.seosmith_audits where delivery_id=p_delivery_id for update;
  if not found then raise exception 'audit_not_found' using errcode='22023'; end if;
  delete from public.seosmith_lifecycle_evaluations where delivery_id=p_delivery_id;
  delete from public.seosmith_lifecycle_observations where delivery_id=p_delivery_id;
  delete from public.seosmith_lifecycle_indexed where delivery_id=p_delivery_id;
  perform public.seosmith_index_lifecycle(p_delivery_id);
end $$;
revoke all on function public.seosmith_lifecycle_reindex(uuid) from public,anon,authenticated;
grant execute on function public.seosmith_lifecycle_reindex(uuid) to service_role;

-- Explicit privileged maintenance; never run by a read. Repeat until zero.
create function public.seosmith_lifecycle_backfill(p_limit integer default 50) returns integer
language plpgsql security definer set search_path='' as $$
declare a record; n integer:=0;
begin
  if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'invalid_limit' using errcode='22023'; end if;
  for a in select audit.delivery_id from public.seosmith_audits audit
    where not exists(select 1 from public.seosmith_lifecycle_indexed i where i.delivery_id=audit.delivery_id)
    order by audit.received_at,audit.delivery_id limit p_limit for update of audit skip locked
  loop perform public.seosmith_index_lifecycle(a.delivery_id); n:=n+1; end loop;
  return n;
end $$;
revoke all on function public.seosmith_lifecycle_backfill(integer) from public,anon,authenticated;
grant execute on function public.seosmith_lifecycle_backfill(integer) to service_role;

-- One row per saved run, including unindexed and omitted/unknown observations.
-- This prevents a gap in the index from becoming a synthetic pass or resolution.
create function public.seosmith_lifecycle_history(p_website_id uuid,p_entity_id text,p_rule text,
  p_limit integer default 50,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; rows jsonb; more boolean; last_row jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if coalesce(p_entity_id,'') !~ '^sha256:[0-9a-f]{64}$' or coalesce(p_rule,'') !~ '^[a-z0-9_]{1,128}$'
     or p_limit is null or p_limit<1 or p_limit>100 or (p_before is null)<>(p_before_id is null)
    then raise exception 'invalid_lifecycle_query' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.scan_at desc,q.delivery_id desc),'[]'::jsonb) into rows from (
    select a.delivery_id,a.scan_at,a.ingestion_source,i.comparison_key,i.schema_version,i.engine_version,i.ruleset_version,
      i.policy_digest,i.evidence_truncated,i.omitted_observations,
      case when i.state='indexed_v1' then (select c from jsonb_array_elements(i.coverage) c where c->>'rule'=p_rule) else null end rule_coverage,
      case when i.delivery_id is null then 'index_pending' when i.state='legacy' then 'legacy_unknown'
        when i.state='unsupported' then 'unsupported' when e.delivery_id is null then 'not_observed'
        when e.evaluation->>'outcome'='unknown' then 'unknown' else 'evaluated' end evidence_state,
      case when e.delivery_id is null then null else jsonb_build_object(
        'entity_id',e.entity_id,'rule',e.rule,'rule_version',e.evaluation->'rule_version',
        'validator_version',e.evaluation->'validator_version','eligibility',e.evaluation->'eligibility',
        'attempt',e.evaluation->'attempt','outcome',e.evaluation->'outcome','unknown_reason',e.evaluation->'unknown_reason',
        'source_locator',e.evaluation->'source_locator','finding_key',e.evaluation->'finding_key',
        'confidence',e.evaluation->'confidence','finding_digest',e.finding_digest,'evidence_values_omitted',true) end evaluation
    from public.seosmith_audits a
    left join public.seosmith_lifecycle_indexed i on i.delivery_id=a.delivery_id
    left join public.seosmith_lifecycle_evaluations e on e.delivery_id=a.delivery_id and e.entity_id=p_entity_id and e.rule=p_rule
    where a.website_id=w.id and a.fqdn=w.fqdn and (p_before is null or (a.scan_at,a.delivery_id)<(p_before,p_before_id))
    order by a.scan_at desc,a.delivery_id desc limit p_limit+1
  ) q;
  more:=jsonb_array_length(rows)>p_limit;
  if more then rows:=rows-p_limit; end if;
  last_row:=rows->(jsonb_array_length(rows)-1);
  return jsonb_build_object('version',1,'entity_id',p_entity_id,'rule',p_rule,'items',rows,'has_more',more,
    'next_cursor',case when more then jsonb_build_object('before',last_row->>'scan_at','before_id',last_row->>'delivery_id') else null end);
end $$;
revoke all on function public.seosmith_lifecycle_history(uuid,text,text,integer,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.seosmith_lifecycle_history(uuid,text,text,integer,timestamptz,uuid) to authenticated;

-- Owner-scoped, bounded URL history. Field hashes represent observed source
-- values; absent keys are unknown, not empty or equal. Values stay in reports.
create function public.seosmith_url_lifecycle_history(p_website_id uuid,p_entity_id text,
  p_limit integer default 50,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; rows jsonb; more boolean; last_row jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if coalesce(p_entity_id,'') !~ '^sha256:[0-9a-f]{64}$' or p_limit is null or p_limit<1 or p_limit>100 or (p_before is null)<>(p_before_id is null)
    then raise exception 'invalid_lifecycle_query' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.scan_at desc,q.delivery_id desc),'[]'::jsonb) into rows from (
    select a.delivery_id,a.scan_at,a.ingestion_source,i.comparison_key,i.schema_version,i.engine_version,i.ruleset_version,i.policy_digest,
      i.evidence_truncated,i.omitted_observations,
      case when i.delivery_id is null then 'index_pending' when i.state='legacy' then 'legacy_unknown'
        when i.state='unsupported' then 'unsupported' when o.delivery_id is null then 'not_observed'
        when o.state='unavailable' then 'unavailable' else 'available' end evidence_state,
      o.source_locator,o.unknown_reason,o.property_digests
    from public.seosmith_audits a
    left join public.seosmith_lifecycle_indexed i on i.delivery_id=a.delivery_id
    left join public.seosmith_lifecycle_observations o on o.delivery_id=a.delivery_id and o.entity_id=p_entity_id
    where a.website_id=w.id and a.fqdn=w.fqdn and (p_before is null or (a.scan_at,a.delivery_id)<(p_before,p_before_id))
    order by a.scan_at desc,a.delivery_id desc limit p_limit+1
  ) q;
  more:=jsonb_array_length(rows)>p_limit;
  if more then rows:=rows-p_limit; end if;
  last_row:=rows->(jsonb_array_length(rows)-1);
  return jsonb_build_object('version',1,'entity_id',p_entity_id,'items',rows,'has_more',more,
    'next_cursor',case when more then jsonb_build_object('before',last_row->>'scan_at','before_id',last_row->>'delivery_id') else null end);
end $$;
revoke all on function public.seosmith_url_lifecycle_history(uuid,text,integer,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.seosmith_url_lifecycle_history(uuid,text,integer,timestamptz,uuid) to authenticated;
