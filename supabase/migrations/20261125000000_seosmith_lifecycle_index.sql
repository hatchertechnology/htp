-- H03: additive, rebuildable index of explicit S01 evaluations. Original audit
-- bytes and receipts remain authoritative. Existing rows require bounded backfill.
create table public.seosmith_lifecycle_indexed (
  delivery_id uuid primary key references public.seosmith_audits(delivery_id) on delete cascade,
  state text not null check (state in ('indexed_v1','legacy','unsupported')),
  index_version integer not null default 1 check (index_version = 1)
);
create table public.seosmith_lifecycle_evaluations (
  delivery_id uuid not null references public.seosmith_audits(delivery_id) on delete cascade,
  entity_id text not null,
  rule text not null,
  evaluation jsonb not null,
  primary key (delivery_id, entity_id, rule)
);
alter table public.seosmith_lifecycle_indexed enable row level security;
alter table public.seosmith_lifecycle_evaluations enable row level security;
revoke all on public.seosmith_lifecycle_indexed, public.seosmith_lifecycle_evaluations from public,anon,authenticated;
grant select,insert,delete on public.seosmith_lifecycle_indexed, public.seosmith_lifecycle_evaluations to service_role;

create function public.seosmith_index_lifecycle(p_delivery_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a public.seosmith_audits; index_state text;
begin
  select * into a from public.seosmith_audits where delivery_id=p_delivery_id;
  if not found then return; end if;
  index_state := case when a.report->>'schema_version'='1' then 'legacy'
    when a.report->>'schema_version'='2' and a.report#>>'{evidence_contract,version}'='1' then 'indexed_v1'
    else 'unsupported' end;
  insert into public.seosmith_lifecycle_indexed(delivery_id,state) values(a.delivery_id,index_state)
    on conflict (delivery_id) do nothing;
  if not found then return; end if;
  if index_state='indexed_v1' then
    insert into public.seosmith_lifecycle_evaluations(delivery_id,entity_id,rule,evaluation)
      select a.delivery_id,e->>'entity_id',e->>'rule',e
      from jsonb_array_elements(a.report#>'{evidence_contract,evaluations}') e;
  end if;
end $$;
revoke all on function public.seosmith_index_lifecycle(uuid) from public,anon,authenticated;

create function public.seosmith_index_lifecycle_trigger() returns trigger language plpgsql security definer set search_path='' as $$
begin perform public.seosmith_index_lifecycle(new.delivery_id); return new; end $$;
revoke all on function public.seosmith_index_lifecycle_trigger() from public,anon,authenticated;
create trigger seosmith_lifecycle_index_after_insert after insert on public.seosmith_audits
for each row execute function public.seosmith_index_lifecycle_trigger();

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
    select a.delivery_id,a.scan_at,a.ingestion_source,a.summary->>'comparison_key' comparison_key,
      a.report->>'schema_version' schema_version,a.report->>'engine_version' engine_version,a.report->>'ruleset_version' ruleset_version,
      a.report#>>'{evidence_contract,policy,signature}' policy_digest,
      case when i.state='indexed_v1' then a.report#>'{evidence_contract,truncated}' else null end evidence_truncated,
      case when i.state='indexed_v1' then a.report#>'{evidence_contract,omitted_observations}' else null end omitted_observations,
      case when i.state='indexed_v1' then (select c from jsonb_array_elements(a.report#>'{evidence_contract,coverage}') c where c->>'rule'=p_rule) else null end rule_coverage,
      case when i.delivery_id is null then 'index_pending' when i.state='legacy' then 'legacy_unknown'
        when i.state='unsupported' then 'unsupported' when e.delivery_id is null then 'not_observed'
        when e.evaluation->>'outcome'='unknown' then 'unknown' else 'evaluated' end evidence_state,
      case when e.delivery_id is null then null else jsonb_build_object(
        'entity_id',e.entity_id,'rule',e.rule,'rule_version',e.evaluation->'rule_version',
        'validator_version',e.evaluation->'validator_version','eligibility',e.evaluation->'eligibility',
        'attempt',e.evaluation->'attempt','outcome',e.evaluation->'outcome','unknown_reason',e.evaluation->'unknown_reason',
        'source_locator',e.evaluation->'source_locator','finding_key',e.evaluation->'finding_key',
        'confidence',e.evaluation->'confidence','evidence_values_omitted',true) end evaluation
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
