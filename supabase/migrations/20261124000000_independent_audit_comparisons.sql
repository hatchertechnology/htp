-- Independent evidence is immutable and deliberately separate from SEOsmith receipts.
create table public.independent_audit_imports (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete restrict,
  fqdn text not null,
  created_at timestamptz not null default now(),
  format text not null check (format = 'controlled-csv-v1'),
  source_text text not null check (octet_length(source_text) between 1 and 4194304),
  source_sha256 text not null,
  metadata jsonb not null check (jsonb_typeof(metadata) = 'object')
);
alter table public.independent_audit_imports enable row level security;
revoke all on public.independent_audit_imports from public, anon, authenticated;
create index independent_audit_imports_history on public.independent_audit_imports (website_id, created_at desc, id desc);

-- Validate the same explicit CSV grammar at the trust boundary, including quoted fields.
-- Byte indexing avoids quadratic UTF-8 character scans; bound individual fields and rows.
create function public.validate_independent_csv(p_source text) returns void
language plpgsql immutable set search_path='' as $$
declare b bytea := convert_to(p_source,'UTF8'); n integer; i integer := 0; start_at integer := 0; c integer;
  quoted boolean := false; closed boolean := false; fields text[] := array[]::text[]; value text;
  rows_seen integer := 0; seen jsonb := '{}'::jsonb; k text;
begin
  if substring(b from 1 for 3)=decode('efbbbf','hex') then b:=substring(b from 4); end if;
  n:=length(b);
  while i<=n loop
    if i=n and start_at=n and cardinality(fields)=0 then exit; end if;
    c:=case when i=n then 10 else get_byte(b,i) end;
    if quoted then
      if i=n then raise exception 'invalid_csv' using errcode='22023'; end if;
      if c=34 then
        if i+1<n and get_byte(b,i+1)=34 then i:=i+1;
        else quoted:=false; closed:=true; end if;
      end if;
    elsif c in (44,10,13) then
      if i-start_at>8192 then raise exception 'csv_field_limit' using errcode='22023'; end if;
      value:=convert_from(substring(b from start_at+1 for i-start_at),'UTF8');
      if left(value,1)='"' then value:=replace(substring(value from 2 for char_length(value)-2),'""','"'); end if;
      fields:=array_append(fields,value); closed:=false;
      if cardinality(fields)>3 then raise exception 'invalid_csv' using errcode='22023'; end if;
      if c<>44 then
        rows_seen:=rows_seen+1;
        if rows_seen>2001 then raise exception 'csv_row_limit' using errcode='22023'; end if;
        if rows_seen=1 then
          if fields is distinct from array['url','rule','state'] then raise exception 'invalid_csv' using errcode='22023'; end if;
        else
          if cardinality(fields)<>3 or fields[1]='' or fields[2]='' or fields[3] not in ('present','absent','unknown') then raise exception 'invalid_csv' using errcode='22023'; end if;
          k:=jsonb_build_array(fields[1],fields[2])::text;
          if seen ? k then raise exception 'duplicate_observation' using errcode='22023'; end if;
          seen:=seen || jsonb_build_object(k,true);
        end if;
        fields:=array[]::text[];
        if c=13 and i+1<n and get_byte(b,i+1)=10 then i:=i+1; end if;
      end if;
      start_at:=i+1;
    elsif c=34 and i=start_at and not closed then quoted:=true;
    elsif c=34 or closed then raise exception 'invalid_csv' using errcode='22023';
    end if;
    i:=i+1;
  end loop;
  if rows_seen=0 then raise exception 'invalid_csv' using errcode='22023'; end if;
end $$;
revoke all on function public.validate_independent_csv(text) from public,anon,authenticated;

create function public.import_independent_audit(p_website_id uuid, p_format text, p_source text, p_metadata jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.websites; item public.independent_audit_imports;
begin
  select * into w from public.websites where id = p_website_id and owner_id = auth.uid() for share;
  if not found or coalesce(auth.jwt()->>'is_anonymous','true') <> 'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if p_format is distinct from 'controlled-csv-v1' or p_source is null or octet_length(p_source) not between 1 and 4194304 or jsonb_typeof(p_metadata) is distinct from 'object' or octet_length(p_metadata::text)>65536 then
    raise exception 'invalid_import' using errcode='22023';
  end if;
  perform public.validate_independent_csv(p_source);
  insert into public.independent_audit_imports(website_id,fqdn,format,source_text,source_sha256,metadata)
  values(w.id,w.fqdn,p_format,p_source,encode(sha256(convert_to(p_source,'UTF8')),'hex'),p_metadata) returning * into item;
  return jsonb_build_object('id',item.id,'source_sha256',item.source_sha256,'created_at',item.created_at);
end $$;
revoke all on function public.import_independent_audit(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.import_independent_audit(uuid,text,text,jsonb) to authenticated;

create function public.independent_audit_history(p_website_id uuid, p_id uuid default null, p_before timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.websites; result jsonb; more boolean; last_row jsonb;
begin
  select * into w from public.websites where id = p_website_id and owner_id = auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true') <> 'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if (p_before is null)<>(p_before_id is null) or (p_id is not null and p_before is not null) then raise exception 'invalid_cursor' using errcode='22023'; end if;
  if p_id is null then
    select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id desc),'[]'::jsonb) into result from
      (select id,created_at,format,source_sha256,metadata from public.independent_audit_imports where website_id=w.id and fqdn=w.fqdn and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit 101) a;
    more:=jsonb_array_length(result)>100;
    if more then result:=result-100; end if;
    last_row:=result->(jsonb_array_length(result)-1);
    result:=jsonb_build_object('items',result,'next_cursor',case when more then jsonb_build_object('before',last_row->>'created_at','before_id',last_row->>'id') else null end);
  else
    select to_jsonb(a) into result from (select id,created_at,format,source_text,source_sha256,metadata from public.independent_audit_imports where website_id=w.id and fqdn=w.fqdn and id=p_id) a;
  end if;
  return result;
end $$;
revoke all on function public.independent_audit_history(uuid,uuid,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.independent_audit_history(uuid,uuid,timestamptz,uuid) to authenticated;

-- A saved comparison pins both evidence receipts and the explicit S15 assertion.
create table public.independent_audit_comparisons (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete restrict,
  fqdn text not null,
  import_id uuid not null references public.independent_audit_imports(id) on delete restrict,
  delivery_id uuid not null references public.seosmith_audits(delivery_id) on delete restrict,
  semantics text not null check (semantics='s15-metadata-1'),
  unmodified_v1_asserted boolean not null,
  created_at timestamptz not null default now()
);
alter table public.independent_audit_comparisons enable row level security;
revoke all on public.independent_audit_comparisons from public, anon, authenticated;
create index independent_comparisons_history on public.independent_audit_comparisons(website_id,created_at desc,id desc);

create function public.save_independent_comparison(p_website_id uuid,p_import_id uuid,p_delivery_id uuid,p_asserted boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; item public.independent_audit_comparisons;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid() for share;
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if p_asserted is null or not exists(select 1 from public.independent_audit_imports where id=p_import_id and website_id=w.id and fqdn=w.fqdn) or not exists(select 1 from public.seosmith_audits where delivery_id=p_delivery_id and website_id=w.id and fqdn=w.fqdn) then
    raise exception 'invalid_comparison' using errcode='22023';
  end if;
  insert into public.independent_audit_comparisons(website_id,fqdn,import_id,delivery_id,semantics,unmodified_v1_asserted)
  values(w.id,w.fqdn,p_import_id,p_delivery_id,'s15-metadata-1',p_asserted) returning * into item;
  return to_jsonb(item);
end $$;
revoke all on function public.save_independent_comparison(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.save_independent_comparison(uuid,uuid,uuid,boolean) to authenticated;

create function public.independent_comparison_history(p_website_id uuid,p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.websites; result jsonb; more boolean; last_row jsonb;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid();
  if not found or coalesce(auth.jwt()->>'is_anonymous','true')<>'false' then raise exception 'forbidden' using errcode='42501'; end if;
  if (p_before is null)<>(p_before_id is null) then raise exception 'invalid_cursor' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id desc),'[]'::jsonb) into result from
    (select id,import_id,delivery_id,semantics,unmodified_v1_asserted,created_at from public.independent_audit_comparisons where website_id=w.id and fqdn=w.fqdn and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit 101) a;
  more:=jsonb_array_length(result)>100;
  if more then result:=result-100; end if;
  last_row:=result->(jsonb_array_length(result)-1);
  return jsonb_build_object('items',result,'next_cursor',case when more then jsonb_build_object('before',last_row->>'created_at','before_id',last_row->>'id') else null end);
end $$;
revoke all on function public.independent_comparison_history(uuid,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.independent_comparison_history(uuid,timestamptz,uuid) to authenticated;
