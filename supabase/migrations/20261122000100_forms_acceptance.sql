-- Origin membership is explicit and cannot cross a website boundary.
alter table public.website_form_hosts add constraint website_form_hosts_website_id_id_key unique (website_id, id);
create table public.website_form_origins (
  website_id uuid not null,
  form_id uuid not null,
  host_id uuid not null,
  primary key (form_id, host_id),
  foreign key (website_id, form_id) references public.website_forms(website_id, id) on delete restrict,
  foreign key (website_id, host_id) references public.website_form_hosts(website_id, id) on delete restrict
);
alter table public.website_form_origins enable row level security;
revoke all on public.website_form_origins from public, anon, authenticated;
grant select on public.website_form_origins to authenticated;
create policy form_origins_owner_read on public.website_form_origins for select to authenticated
  using (exists (select 1 from public.websites w where w.id = website_id and w.owner_id = (select auth.uid())) and (select auth.jwt()->>'is_anonymous') = 'false');

create table public.website_form_rate_windows (
  form_id uuid primary key references public.website_forms(id) on delete cascade,
  started_at timestamptz not null,
  count integer not null check (count >= 0)
);
alter table public.website_form_rate_windows enable row level security;
revoke all on public.website_form_rate_windows from public, anon, authenticated;

-- Minimal retained hashes preserve idempotency after a response is deleted.
create table public.website_form_submission_tombstones (
  form_id uuid not null references public.website_forms(id) on delete restrict,
  submission_id uuid not null,
  value_hash text not null,
  deleted_at timestamptz not null default now(),
  primary key(form_id,submission_id)
);
alter table public.website_form_submission_tombstones enable row level security;
revoke all on public.website_form_submission_tombstones from public, anon, authenticated;

-- Privileged callers must supply a canonical HTTPS origin hostname. This RPC
-- is deliberately unavailable to browser roles. The function rechecks all
-- safety-critical state in the same transaction that stores the response.
create function public.accept_website_form(p_form_id uuid, p_submission_id uuid, p_host text, p_values jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.website_forms%rowtype;
  existing public.website_form_responses%rowtype;
  field jsonb; k text; v text; errors jsonb := '{}'::jsonb; window_row public.website_form_rate_windows%rowtype;
begin
  select * into f from public.website_forms where id = p_form_id for update;
  if not found or not f.active or not exists (
    select 1 from public.website_form_origins o join public.website_form_hosts h on h.id=o.host_id and h.website_id=o.website_id
    where o.form_id=f.id and o.website_id=f.website_id and h.hostname=p_host and h.verified_at is not null
  ) then return jsonb_build_object('error','form_unavailable'); end if;
  if p_submission_id is null or jsonb_typeof(p_values) is distinct from 'object' or octet_length(p_values::text)>16384 then
    return jsonb_build_object('error','invalid_request');
  end if;
  select * into existing from public.website_form_responses where form_id=f.id and submission_id=p_submission_id;
  if found then
    if existing.values = p_values then return jsonb_build_object('ok',true,'duplicate',true); end if;
    return jsonb_build_object('error','idempotency_conflict');
  end if;
  if exists(select 1 from public.website_form_submission_tombstones where form_id=f.id and submission_id=p_submission_id) then
    if exists(select 1 from public.website_form_submission_tombstones where form_id=f.id and submission_id=p_submission_id and value_hash=encode(sha256(convert_to(p_values::text,'UTF8')),'hex')) then return jsonb_build_object('ok',true,'duplicate',true); end if;
    return jsonb_build_object('error','idempotency_conflict');
  end if;
  insert into public.website_form_rate_windows(form_id,started_at,count) values(f.id,now(),0) on conflict do nothing;
  select * into window_row from public.website_form_rate_windows where form_id=f.id for update;
  if window_row.started_at <= now()-interval '10 minutes' then
    update public.website_form_rate_windows set started_at=now(),count=1 where form_id=f.id;
  elsif window_row.count >= 100 then return jsonb_build_object('error','rate_limited');
  else update public.website_form_rate_windows set count=count+1 where form_id=f.id; end if;
  if jsonb_array_length(f.fields) not between 1 and 32 then return jsonb_build_object('error','form_unavailable'); end if;
  for k in select jsonb_object_keys(p_values) loop
    if not exists (select 1 from jsonb_array_elements(f.fields) x where x->>'key'=k) then
      errors := errors || jsonb_build_object('_form','Unknown field.');
    end if;
  end loop;
  for field in select * from jsonb_array_elements(f.fields) loop
    k := field->>'key';
    if k is null or k !~ '^[a-z][a-z0-9_]{0,63}$' or field->>'kind' not in ('text','email','telephone','multiline') or jsonb_typeof(field->'required') is distinct from 'boolean' or coalesce(field->>'max_length','') !~ '^[1-9][0-9]{0,3}$' or (field->>'max_length')::int > 5000 then
      return jsonb_build_object('error','form_unavailable');
    end if;
    if p_values ? k and jsonb_typeof(p_values->k) <> 'string' then errors := errors || jsonb_build_object(k,'Enter text.'); continue; end if;
    v := btrim(coalesce(p_values->>k,''));
    if v='' and (field->>'required')::boolean then errors := errors || jsonb_build_object(k,'This field is required.');
    elsif char_length(v) > (field->>'max_length')::int then errors := errors || jsonb_build_object(k,'This field is too long.');
    elsif field->>'kind'='email' and v<>'' and (length(v)>254 or v !~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~.-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' or split_part(v,'@',1) ~ '(^\.|\.\.|\.$)' or length(split_part(v,'@',1))>64) then
      errors := errors || jsonb_build_object(k,'Enter a valid email address.');
    end if;
  end loop;
  if errors <> '{}'::jsonb then return jsonb_build_object('error','validation_failed','fields',errors); end if;
  insert into public.website_form_responses(website_id,form_id,submission_id,values) values(f.website_id,f.id,p_submission_id,p_values);
  return jsonb_build_object('ok',true,'duplicate',false);
end $$;
revoke all on function public.accept_website_form(uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.accept_website_form(uuid,uuid,text,jsonb) to service_role;

create function public.website_form_origin_allowed(p_form_id uuid, p_host text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.website_forms f
    join public.website_form_origins o on o.form_id=f.id and o.website_id=f.website_id
    join public.website_form_hosts h on h.id=o.host_id and h.website_id=o.website_id
    where f.id=p_form_id and f.active and h.hostname=p_host and h.verified_at is not null)
$$;
revoke all on function public.website_form_origin_allowed(uuid,text) from public, anon, authenticated;
grant execute on function public.website_form_origin_allowed(uuid,text) to service_role;
