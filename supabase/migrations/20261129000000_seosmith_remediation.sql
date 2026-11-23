-- Mutable work planning is separate from immutable crawl evidence.
create table public.seosmith_remediation (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  delivery_id uuid not null references public.seosmith_audits(delivery_id) on delete cascade,
  finding_index integer not null check (finding_index >= 0),
  finding_key text not null,
  status text not null default 'open' check (status in ('open','in_progress','done','excepted')),
  assignee text, segments jsonb not null default '{}'::jsonb,
  exception_note text, notes text, business_exposure text, estimated_effort text, rationale text,
  updated_at timestamptz not null default now(),
  unique (delivery_id, finding_index)
);
create index seosmith_remediation_site_audit on public.seosmith_remediation(website_id,delivery_id);
create table public.seosmith_verification_attempts (
  id uuid primary key default gen_random_uuid(),
  remediation_id uuid not null references public.seosmith_remediation(id) on delete cascade,
  delivery_id uuid references public.seosmith_audits(delivery_id) on delete restrict,
  result text not null check (result in ('observed','unverified')),
  note text not null check (octet_length(note) between 1 and 4096),
  created_at timestamptz not null default now()
);
create index seosmith_verification_attempts_work on public.seosmith_verification_attempts(remediation_id,created_at desc,id desc);
alter table public.seosmith_remediation enable row level security;
alter table public.seosmith_verification_attempts enable row level security;
revoke all on public.seosmith_remediation,public.seosmith_verification_attempts from public,anon,authenticated;
grant all on public.seosmith_remediation,public.seosmith_verification_attempts to service_role;

create function public.seosmith_remediation_list(p_website_id uuid,p_delivery_id uuid,p_finding_index integer,p_before timestamptz default null,p_before_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.websites;
begin
 select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
 if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
 if not exists(select 1 from public.seosmith_audits where website_id=w.id and fqdn=w.fqdn and delivery_id=p_delivery_id) then raise exception 'audit_not_found' using errcode='22023'; end if;
 if p_finding_index is null or p_finding_index<0 or (p_before is null)<>(p_before_id is null) then raise exception 'invalid_page' using errcode='22023'; end if;
 return coalesce((select jsonb_agg(to_jsonb(m) || jsonb_build_object('attempts',coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at desc,v.id desc) from (select * from public.seosmith_verification_attempts where remediation_id=m.id and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit 50) v),'[]'::jsonb), 'attempts_more',exists(select 1 from public.seosmith_verification_attempts where remediation_id=m.id and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc offset 50 limit 1))) from public.seosmith_remediation m where m.website_id=w.id and m.delivery_id=p_delivery_id and m.finding_index=p_finding_index),'[]'::jsonb);
end $$;

create function public.seosmith_remediation_save(p_website_id uuid,p_delivery_id uuid,p_finding_index integer,p_work jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.websites; a public.seosmith_audits; f jsonb; m public.seosmith_remediation; k text;
begin
 select * into w from public.websites where id=p_website_id and owner_id=auth.uid() for share;
 if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
 select * into a from public.seosmith_audits where delivery_id=p_delivery_id and website_id=w.id and fqdn=w.fqdn for share;
 if not found or a.report->>'schema_version' not in ('1','2') or p_finding_index is null or p_finding_index<0 then raise exception 'invalid_audit_or_finding' using errcode='22023'; end if;
 f:=a.report->'findings'->p_finding_index;
 if jsonb_typeof(f) is distinct from 'object' or coalesce(f->>'key','')='' then raise exception 'invalid_audit_or_finding' using errcode='22023'; end if;
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

create function public.seosmith_remediation_attempt(p_website_id uuid,p_work_id uuid,p_delivery_id uuid,p_result text,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w public.websites; m public.seosmith_remediation; v public.seosmith_verification_attempts;
begin
 select * into w from public.websites where id=p_website_id and owner_id=auth.uid() for share;
 if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
 select rm.* into m from public.seosmith_remediation rm join public.seosmith_audits a on a.delivery_id=rm.delivery_id where rm.id=p_work_id and rm.website_id=w.id and a.fqdn=w.fqdn for share of rm;
 if not found or (p_delivery_id is not null and not exists(select 1 from public.seosmith_audits where delivery_id=p_delivery_id and website_id=w.id and fqdn=w.fqdn)) then raise exception 'invalid_work_or_audit' using errcode='22023'; end if;
 if p_result is null or p_result not in ('observed','unverified') or p_note is null or octet_length(p_note) not between 1 and 4096 then raise exception 'invalid_attempt' using errcode='22023'; end if;
 insert into public.seosmith_verification_attempts(remediation_id,delivery_id,result,note) values(m.id,p_delivery_id,p_result,p_note) returning * into v;
 return to_jsonb(v);
end $$;
revoke all on function public.seosmith_remediation_list(uuid,uuid,integer,timestamptz,uuid),public.seosmith_remediation_save(uuid,uuid,integer,jsonb),public.seosmith_remediation_attempt(uuid,uuid,uuid,text,text) from public,anon;
grant execute on function public.seosmith_remediation_list(uuid,uuid,integer,timestamptz,uuid),public.seosmith_remediation_save(uuid,uuid,integer,jsonb),public.seosmith_remediation_attempt(uuid,uuid,uuid,text,text) to authenticated;
