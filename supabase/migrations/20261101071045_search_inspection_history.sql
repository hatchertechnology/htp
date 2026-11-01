-- Append-only indexed-version observations. The owner-scoped RPC also permits
-- manual submission, so provenance never claims server-authenticated Google data.
create table public.search_inspection_observations (
  id bigint generated always as identity primary key,
  website_id uuid not null references public.websites(id) on delete cascade,
  fqdn text not null,
  site_url text not null,
  url text not null,
  observed_at timestamptz not null default now(),
  semantics_version integer not null default 1 check (semantics_version=1),
  provenance text not null default 'owner_submitted_indexed_inspection',
  data jsonb not null check (jsonb_typeof(data->'inspectionResult')='object')
);
-- Keep potentially 2,048-character property/URL values out of B-tree tuples.
-- Exact source predicates below still isolate records; this index supplies the
-- website/hostname scope and descending cursor order without tuple-size failures.
create index search_inspection_observations_history on public.search_inspection_observations(website_id,fqdn,id desc);
alter table public.search_inspection_observations enable row level security;
revoke all on public.search_inspection_observations from public,anon,authenticated;
revoke all on sequence public.search_inspection_observations_id_seq from public,anon,authenticated;

create function public.save_search_inspection(p_website_id uuid,p_fqdn text,p_site_url text,p_url text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.websites; observation public.search_inspection_observations;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous','true')='false' for no key update;
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  if p_fqdn is distinct from w.fqdn or p_site_url is null or length(p_site_url)>2048
    or p_url is null or length(p_url)>2048
    or p_url !~ ('^https?://' || replace(w.fqdn,'.','\.') || '/')
    or p_url like '%#%'
    or not ((p_site_url like 'sc-domain:%' and (substring(p_site_url from 11)=w.fqdn
      or w.fqdn like '%.' || replace(replace(substring(p_site_url from 11),'%','\%'),'_','\_')))
      or (p_site_url ~ ('^https?://' || replace(w.fqdn,'.','\.') || '/')
        and right(p_site_url,1)='/' and position('?' in p_site_url)=0 and position('#' in p_site_url)=0
        and left(p_url,length(p_site_url))=p_site_url))
    or p_data is null or jsonb_typeof(p_data) is distinct from 'object'
    or jsonb_typeof(p_data->'inspectionResult') is distinct from 'object'
    or octet_length(p_data::text)>262144 then
    raise invalid_parameter_value using message='Invalid indexed inspection';
  end if;
  insert into public.search_inspection_observations(website_id,fqdn,site_url,url,data)
    values(w.id,w.fqdn,p_site_url,p_url,p_data) returning * into observation;
  return jsonb_build_object('id',observation.id,'observed_at',observation.observed_at,
    'semantics_version',observation.semantics_version,'provenance',observation.provenance,'mode','indexed_version');
end $$;
revoke all on function public.save_search_inspection(uuid,text,text,text,jsonb) from public,anon;
grant execute on function public.save_search_inspection(uuid,text,text,text,jsonb) to authenticated;

create function public.search_inspection_history(p_website_id uuid,p_site_url text,p_url text,p_before_id bigint default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.websites; records jsonb; more boolean;
begin
  select * into w from public.websites where id=p_website_id and owner_id=auth.uid()
    and coalesce(auth.jwt()->>'is_anonymous','true')='false';
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  if p_site_url is null or p_url is null or length(p_site_url)>2048 or length(p_url)>2048
    or p_before_id <= 0 then raise invalid_parameter_value using message='Invalid history cursor'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc),'[]'::jsonb) into records from (
    select id,site_url,url,observed_at,semantics_version,provenance,data from public.search_inspection_observations
    where website_id=w.id and fqdn=w.fqdn and site_url=p_site_url and url=p_url
      and (p_before_id is null or id<p_before_id) order by id desc limit 51
  ) r;
  more := jsonb_array_length(records)>50;
  if more then records := records - 50; end if;
  return jsonb_build_object('observations',records,'has_more',more,'mode','indexed_version',
    'next_before_id',case when more then (records->49->>'id')::bigint else null end);
end $$;
revoke all on function public.search_inspection_history(uuid,text,text,bigint) from public,anon;
grant execute on function public.search_inspection_history(uuid,text,text,bigint) to authenticated;
