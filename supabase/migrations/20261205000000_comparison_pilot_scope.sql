-- Default-empty comparison pilot gate. Does not insert an approval or reopen any
-- held comparison RPC. The gate is an empty (website_id, owner_id) allowlist. A
-- single locked helper binds the approved owner to the actual requesting auth.uid()
-- and returns the stable website row used by all seven comparison RPCs and the
-- pilot cleanup. Applying this migration preserves the held public ACLs: the RPCs are
-- revoked from PUBLIC, anon and authenticated, never granted. A later, separately
-- reviewed release may provision an approval and grant access; nothing here does.
begin;

-- Refuse source or security-configuration drift before replacing any function.
-- The seven existing comparison RPCs must be the exact, reviewed security-definer
-- bodies with a fixed empty search_path. Any divergence aborts the transaction.
do $guard$
declare item record; func oid; r text; member_name text; signature text;
begin
  for item in select * from (values
    ('public.import_independent_audit(uuid,text,text,jsonb)','1b8279822047bba40e7d267ba9ee0a17e639842ffbcc90cae275e4c4fb978e83'),
    ('public.independent_audit_history(uuid,uuid,timestamptz,uuid)','68975c17683aca8e580427b590c6757120cff91ca995ce31edb7e00bc5bcd2c0'),
    ('public.save_independent_comparison(uuid,uuid,uuid,boolean)','425c5a57b3fffd2d5c07a147d1fd1744c1ca585e1ca9727f4522ad08060cb910'),
    ('public.independent_comparison_history(uuid,timestamptz,uuid)','1181f417783310e263a6299599df29c6d20a72adeee62ffe033457b5ad5851e5'),
    ('public.independent_comparison_detail(uuid,uuid)','2acafb6078ed8496e3f312098ed90fd194b5277b41d3bf2762a42b36ace0fbb8'),
    ('public.independent_evidence_fingerprint(uuid)','d77cc655157df2a4ab472b02276583f4a16f8b7578f8404af0d7e19c516c24cf'),
    ('public.delete_independent_audit_evidence(uuid,text,text)','3afb325fec2bb02f24f5d56a7a1e27034df561a6b25264702f5776a0dd39e726')) as expected(signature,source_sha256) loop
    func := to_regprocedure(item.signature);
    if func is null or not exists (select 1 from pg_proc p where p.oid=func and p.prosecdef and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=item.source_sha256 and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=', 'search_path=""'))) then
      raise exception 'comparison_pilot_function_drift: %', item.signature;
    end if;
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists (select 1 from pg_proc p where p.oid=func and pg_has_role(r,p.proowner,'MEMBER')) then raise exception 'comparison_pilot_owner_membership_drift'; end if;
    end loop;
  end loop;
  if to_regclass('public.comparison_pilot_approved_sites') is not null then raise exception 'comparison_pilot_approval_exists'; end if;
  if to_regprocedure('public.comparison_pilot_site_allowed(uuid)') is not null then raise exception 'comparison_pilot_helper_exists'; end if;
end $guard$;

-- Empty-by-default admin-only site/owner allowlist. RLS is enabled and every
-- privilege is revoked, including service_role, so no API identity can read or
-- alter the pilot scope.
create table public.comparison_pilot_approved_sites (
  website_id uuid primary key references public.websites(id) on delete cascade,
  owner_id uuid not null
);
alter table public.comparison_pilot_approved_sites enable row level security;
revoke all on public.comparison_pilot_approved_sites from public, anon, authenticated, service_role;
-- Reject inherited privileges or membership in the owning role. REVOKE alone
-- cannot undo a grant inherited through some other role.
do $$
declare r text; reachable_role text; p text; c text; owner_name text;
begin
  select pg_get_userbyid(relowner) into owner_name from pg_class where oid='public.comparison_pilot_approved_sites'::regclass;
  foreach r in array array['anon','authenticated','service_role'] loop
    if pg_has_role(r,owner_name,'MEMBER') then raise exception 'comparison_pilot_approval_owner_membership'; end if;
    -- Include every membership-reachable role, even NOINHERIT memberships
    -- which could be activated with SET ROLE rather than inherited directly.
    for reachable_role in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
      foreach p in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
        if has_table_privilege(reachable_role,'public.comparison_pilot_approved_sites',p) then raise exception 'comparison_pilot_approval_privilege_drift'; end if;
      end loop;
      foreach c in array array['website_id','owner_id'] loop
        foreach p in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
          if has_column_privilege(reachable_role,'public.comparison_pilot_approved_sites',c,p) then raise exception 'comparison_pilot_approval_column_privilege_drift'; end if;
        end loop;
      end loop;
    end loop;
  end loop;
end $$;

-- Authorize and lock in one statement, and return the stable website row that
-- every caller must use. The join requires both the approved owner and the actual
-- requesting auth.uid(), so a stale approval, an ownership change or a different
-- caller cannot authorize the site. The approval and website rows stay locked
-- until transaction end, so approval removal and ownership transfer wait for any
-- guarded in-flight transaction. Returning the row prevents a caller from
-- re-resolving the website through a separate unlocked owner lookup.
create function public.comparison_pilot_site_allowed(p_website_id uuid)
returns public.websites language plpgsql volatile security definer set search_path='' as $$
declare w public.websites;
begin
  select site.* into w
    from public.comparison_pilot_approved_sites a
    join public.websites site on site.id=a.website_id and site.owner_id=a.owner_id and site.owner_id=auth.uid()
    where a.website_id=p_website_id for update of a,site;
  return w;
end $$;
revoke all on function public.comparison_pilot_site_allowed(uuid) from public,anon,authenticated,service_role;
do $$
declare r text; reachable_role text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    for reachable_role in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
      if has_function_privilege(reachable_role,'public.comparison_pilot_site_allowed(uuid)','execute') then raise exception 'comparison_pilot_helper_privilege_drift'; end if;
    end loop;
  end loop;
end $$;

-- The seven existing RPCs keep their signatures and return shapes. Each keeps its
-- nonanonymous check, then authorizes through the locked helper and uses only the
-- website row the helper returned.
create or replace function public.import_independent_audit(p_website_id uuid, p_format text, p_source text, p_metadata jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.websites; item public.independent_audit_imports;
begin
  if coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  w := public.comparison_pilot_site_allowed(p_website_id);
  if w.id is null then raise exception 'forbidden' using errcode='42501'; end if;
  if p_format is distinct from 'controlled-csv-v1' or p_source is null or octet_length(p_source) not between 1 and 4194304 or jsonb_typeof(p_metadata) is distinct from 'object' or octet_length(p_metadata::text)>65536 then
    raise exception 'invalid_import' using errcode='22023';
  end if;
  perform public.validate_independent_csv(p_source);
  insert into public.independent_audit_imports(website_id,fqdn,format,source_text,source_sha256,metadata)
  values(w.id,w.fqdn,p_format,p_source,encode(sha256(convert_to(p_source,'UTF8')),'hex'),p_metadata) returning * into item;
  return jsonb_build_object('id',item.id,'source_sha256',item.source_sha256,'created_at',item.created_at);
end $$;

create or replace function public.independent_audit_history(p_website_id uuid, p_id uuid default null, p_before timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.websites; result jsonb; more boolean; last_row jsonb;
begin
  if coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  w := public.comparison_pilot_site_allowed(p_website_id);
  if w.id is null then raise exception 'forbidden' using errcode='42501'; end if;
  if (p_before is null)<>(p_before_id is null) or (p_id is not null and p_before is not null) then raise exception 'invalid_cursor' using errcode='22023'; end if;
  if p_id is null then
    select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id desc),'[]'::jsonb) into result from
      (select id,fqdn,created_at,format,source_sha256,metadata from public.independent_audit_imports where website_id=w.id and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit 101) a;
    more:=jsonb_array_length(result)>100;
    if more then result:=result-100; end if;
    last_row:=result->(jsonb_array_length(result)-1);
    result:=jsonb_build_object('items',result,'next_cursor',case when more then jsonb_build_object('before',last_row->>'created_at','before_id',last_row->>'id') else null end);
  else
    select to_jsonb(a) into result from (select id,fqdn,created_at,format,source_text,source_sha256,metadata from public.independent_audit_imports where website_id=w.id and id=p_id) a;
  end if;
  return result;
end $$;

create or replace function public.save_independent_comparison(p_website_id uuid,p_import_id uuid,p_delivery_id uuid,p_asserted boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; item public.independent_audit_comparisons;
begin
  if coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  w := public.comparison_pilot_site_allowed(p_website_id);
  if w.id is null then raise exception 'forbidden' using errcode='42501'; end if;
  if p_asserted is null or not exists(select 1 from public.independent_audit_imports i join public.seosmith_audits a on a.website_id=i.website_id and a.fqdn=i.fqdn where i.id=p_import_id and i.website_id=w.id and a.delivery_id=p_delivery_id) then
    raise exception 'invalid_comparison' using errcode='22023';
  end if;
  insert into public.independent_audit_comparisons(website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted)
  select w.id,i.fqdn,p_import_id,p_delivery_id,'s15-metadata-1',p_asserted from public.independent_audit_imports i where i.id=p_import_id returning * into item;
  return to_jsonb(item);
end $$;

create or replace function public.independent_comparison_history(p_website_id uuid,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; result jsonb; more boolean; last_row jsonb;
begin
  if coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  w := public.comparison_pilot_site_allowed(p_website_id);
  if w.id is null then raise exception 'forbidden' using errcode='42501'; end if;
  if (p_before is null)<>(p_before_id is null) then raise exception 'invalid_cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id desc),'[]'::jsonb) into result from
    (select id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted,created_at from public.independent_audit_comparisons where website_id=w.id and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit 101) a;
  more:=jsonb_array_length(result)>100;
  if more then result:=result-100; end if;
  last_row:=result->(jsonb_array_length(result)-1);
  return jsonb_build_object('items',result,'next_cursor',case when more then jsonb_build_object('before',last_row->>'created_at','before_id',last_row->>'id') else null end);
end $$;

create or replace function public.independent_comparison_detail(p_website_id uuid,p_comparison_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; result jsonb;
begin
  if coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  w := public.comparison_pilot_site_allowed(p_website_id);
  if w.id is null then raise exception 'forbidden' using errcode='42501'; end if;
  select jsonb_build_object('comparison',to_jsonb(c),'source',to_jsonb(i)-'website_id',
    'seosmith',jsonb_build_object('delivery_id',a.delivery_id,'fqdn',a.fqdn,'sha256',a.sha256,
      'report',a.report,'report_json',to_jsonb(a)->>'raw_report_json')) into result
  from public.independent_audit_comparisons c
  join public.independent_audit_imports i on i.id=c.import_id and i.website_id=c.website_id
  join public.seosmith_audits a on a.delivery_id=c.delivery_id and a.website_id=c.website_id
  where c.id=p_comparison_id and c.website_id=w.id;
  return result;
end $$;

create or replace function public.independent_evidence_fingerprint(p_website_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare w public.websites; result text;
begin
  if coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  w := public.comparison_pilot_site_allowed(p_website_id);
  if w.id is null then raise exception 'forbidden' using errcode='42501'; end if;
  select encode(sha256(convert_to(coalesce(string_agg(v,',' order by v),''),'UTF8')),'hex') into result from (
    select 'i:'||id::text v from public.independent_audit_imports where website_id=w.id
    union all select 'c:'||id::text v from public.independent_audit_comparisons where website_id=w.id
  ) q;
  return result;
end $$;

create or replace function public.delete_independent_audit_evidence(p_website_id uuid,p_confirmation text,p_export_fingerprint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; comparisons_deleted integer; imports_deleted integer;
begin
  if coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  w := public.comparison_pilot_site_allowed(p_website_id);
  if w.id is null then raise exception 'forbidden' using errcode='42501'; end if;
  if p_confirmation is distinct from 'DELETE INDEPENDENT EVIDENCE' then raise exception 'confirmation_required' using errcode='22023'; end if;
  if p_export_fingerprint is null or p_export_fingerprint is distinct from public.independent_evidence_fingerprint(w.id) then raise exception 'evidence_changed_export_again' using errcode='22023'; end if;
  delete from public.independent_audit_comparisons where website_id=w.id;
  get diagnostics comparisons_deleted = row_count;
  delete from public.independent_audit_imports where website_id=w.id;
  get diagnostics imports_deleted = row_count;
  return jsonb_build_object('comparisons_deleted',comparisons_deleted,'imports_deleted',imports_deleted);
end $$;

-- Pilot-only bounded cleanup. Unlike the site-wide delete RPC, this refuses to run
-- unless the supplied import and comparison identities exactly equal the site's
-- current evidence and the supplied fingerprint matches. A mismatch changes
-- nothing. The shared helper locks the approval and website rows exclusively, so
-- it serializes with imports, saves, approval removal and ownership transfer.
create function public.delete_comparison_pilot_evidence(p_website_id uuid,p_import_ids uuid[],p_comparison_ids uuid[],p_export_fingerprint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; actual_imports uuid[]; actual_comparisons uuid[]; expected_imports uuid[]; expected_comparisons uuid[]; comparisons_deleted integer; imports_deleted integer;
begin
  if coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  w := public.comparison_pilot_site_allowed(p_website_id);
  if w.id is null then raise exception 'forbidden' using errcode='42501'; end if;
  if p_import_ids is null or p_comparison_ids is null or exists(select 1 from unnest(p_import_ids) x where x is null) or exists(select 1 from unnest(p_comparison_ids) x where x is null) then
    raise exception 'invalid_scope' using errcode='22023';
  end if;
  if (select count(*) from unnest(p_import_ids))<>(select count(distinct x) from unnest(p_import_ids) x) or (select count(*) from unnest(p_comparison_ids))<>(select count(distinct x) from unnest(p_comparison_ids) x) then
    raise exception 'invalid_scope' using errcode='22023';
  end if;
  select coalesce(array_agg(x order by x),'{}'::uuid[]) into expected_imports from unnest(p_import_ids) x;
  select coalesce(array_agg(x order by x),'{}'::uuid[]) into expected_comparisons from unnest(p_comparison_ids) x;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into actual_imports from public.independent_audit_imports where website_id=w.id;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into actual_comparisons from public.independent_audit_comparisons where website_id=w.id;
  if actual_imports is distinct from expected_imports or actual_comparisons is distinct from expected_comparisons then
    raise exception 'evidence_scope_mismatch' using errcode='22023';
  end if;
  if p_export_fingerprint is null or p_export_fingerprint is distinct from public.independent_evidence_fingerprint(w.id) then
    raise exception 'evidence_changed_export_again' using errcode='22023';
  end if;
  delete from public.independent_audit_comparisons where website_id=w.id and id=any(p_comparison_ids);
  get diagnostics comparisons_deleted = row_count;
  delete from public.independent_audit_imports where website_id=w.id and id=any(p_import_ids);
  get diagnostics imports_deleted = row_count;
  return jsonb_build_object('comparisons_deleted',comparisons_deleted,'imports_deleted',imports_deleted);
end $$;

-- Prove at installation time that the helper is caller-bound and that every
-- guarded caller uses it instead of re-resolving websites with a separate lookup.
do $verify$
declare signature text; func oid;
begin
  func := to_regprocedure('public.comparison_pilot_site_allowed(uuid)');
  if func is null or not exists (select 1 from pg_proc p where p.oid=func
    and p.prosrc like '%site.owner_id=a.owner_id and site.owner_id=auth.uid()%'
    and p.prosrc like '%for update of a,site%') then
    raise exception 'comparison_pilot_helper_binding_drift';
  end if;
  foreach signature in array array[
    'public.import_independent_audit(uuid,text,text,jsonb)',
    'public.independent_audit_history(uuid,uuid,timestamptz,uuid)',
    'public.save_independent_comparison(uuid,uuid,uuid,boolean)',
    'public.independent_comparison_history(uuid,timestamptz,uuid)',
    'public.independent_comparison_detail(uuid,uuid)',
    'public.independent_evidence_fingerprint(uuid)',
    'public.delete_independent_audit_evidence(uuid,text,text)',
    'public.delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text)'] loop
    func := to_regprocedure(signature);
    if func is null or not exists (select 1 from pg_proc p where p.oid=func
      and p.prosrc like '%public.comparison_pilot_site_allowed(p_website_id)%'
      and p.prosrc not like '%from public.websites%') then
      raise exception 'comparison_pilot_site_binding_drift: %', signature;
    end if;
  end loop;
end $verify$;

-- Preserve the held public ACLs. No grant to anon, authenticated or service_role
-- is introduced by this migration.
revoke execute on function public.import_independent_audit(uuid,text,text,jsonb),public.independent_audit_history(uuid,uuid,timestamptz,uuid),public.save_independent_comparison(uuid,uuid,uuid,boolean),public.independent_comparison_history(uuid,timestamptz,uuid),public.independent_comparison_detail(uuid,uuid),public.independent_evidence_fingerprint(uuid),public.delete_independent_audit_evidence(uuid,text,text) from public,anon,authenticated;
revoke all on function public.delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text) from public,anon,authenticated,service_role;

-- Fail closed if any PUBLIC-reachable identity still has execute. service_role is
-- intentionally not asserted for the seven existing RPCs: the pre-existing
-- provider default may allow it on readers/fingerprint, and this migration does
-- not change service_role. The new pilot cleanup is service_role-denied.
do $holds$
declare r text; member_name text; signature text;
begin
  foreach r in array array['anon','authenticated'] loop
    for member_name in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
      foreach signature in array array['public.import_independent_audit(uuid,text,text,jsonb)','public.independent_audit_history(uuid,uuid,timestamptz,uuid)','public.save_independent_comparison(uuid,uuid,uuid,boolean)','public.independent_comparison_history(uuid,timestamptz,uuid)','public.independent_comparison_detail(uuid,uuid)','public.independent_evidence_fingerprint(uuid)','public.delete_independent_audit_evidence(uuid,text,text)','public.delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text)'] loop
        if has_function_privilege(member_name,signature,'EXECUTE') then raise exception 'comparison_pilot_owner_hold_drift'; end if;
      end loop;
    end loop;
  end loop;
  for member_name in select rolname from pg_roles where pg_has_role('service_role',oid,'MEMBER') loop
    if has_function_privilege(member_name,'public.delete_comparison_pilot_evidence(uuid,uuid[],uuid[],text)','EXECUTE') then raise exception 'comparison_pilot_cleanup_service_hold_drift'; end if;
  end loop;
end $holds$;
commit;
