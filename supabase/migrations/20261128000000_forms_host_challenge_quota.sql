-- Account-wide, bounded accounting: one row per existing account, not per
-- hostname or attempt. Rows cascade only when the account itself is deleted.
create table public.website_form_host_challenge_windows (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  count integer not null check (count between 0 and 60)
);
alter table public.website_form_host_challenge_windows enable row level security;
revoke all on public.website_form_host_challenge_windows from public, anon, authenticated;

-- Lock order: auth user key-share, account window, then website row. Website
-- ownership is checked both before allocating accounting state and again with
-- the website lock; all writes, proof rotation and accounting commit together.
create or replace function public.begin_form_host_verification(p_website_id uuid, p_hostname text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  caller uuid := (select auth.uid());
  token text;
  host_id uuid;
  window_row public.website_form_host_challenge_windows%rowtype;
  sampled_at timestamptz;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or caller is null
    or not exists (select 1 from public.websites where id=p_website_id and owner_id=caller) then
    raise exception 'Website not found' using errcode='42501';
  end if;
  if p_hostname is null or p_hostname <> lower(p_hostname) or octet_length(p_hostname) not between 3 and 253 or p_hostname !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' or p_hostname ~ '\.[0-9]+$' then
    raise exception 'Invalid hostname' using errcode='22023';
  end if;

  perform 1 from auth.users where id=caller for key share;
  if not found then raise exception 'Website not found' using errcode='42501'; end if;
  insert into public.website_form_host_challenge_windows(owner_id,started_at,count)
    values(caller,now(),0) on conflict(owner_id) do nothing;
  select * into window_row from public.website_form_host_challenge_windows where owner_id=caller for update;
  perform 1 from public.websites where id=p_website_id and owner_id=caller for update;
  if not found then raise exception 'Website not found' using errcode='42501'; end if;

  sampled_at := clock_timestamp();
  if window_row.started_at > sampled_at-interval '10 minutes' and window_row.count >= 60 then
    raise exception 'form_host_rate_limited' using errcode='P0001';
  end if;
  if not exists(select 1 from public.website_form_hosts where website_id=p_website_id and hostname=p_hostname) then
    if (select count(*) from (select 1 from public.website_form_hosts where website_id=p_website_id limit 64) capped_site) >= 64 then
      raise exception 'form_host_limit' using errcode='P0001';
    end if;
    if (select count(*) from (select 1 from public.website_form_hosts h join public.websites w on w.id=h.website_id where w.owner_id=caller limit 256) capped_account) >= 256 then
      raise exception 'form_host_account_limit' using errcode='P0001';
    end if;
  end if;
  update public.website_form_host_challenge_windows set
    started_at=case when window_row.started_at <= sampled_at-interval '10 minutes' then sampled_at else window_row.started_at end,
    count=case when window_row.started_at <= sampled_at-interval '10 minutes' then 1 else window_row.count+1 end
    where owner_id=caller;
  token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into public.website_form_hosts(website_id,hostname,challenge_hash,verified_at)
    values(p_website_id,p_hostname,encode(sha256(convert_to(token,'UTF8')),'hex'),null)
    on conflict (website_id,hostname) do update set challenge_hash=excluded.challenge_hash,verified_at=null,created_at=now()
    returning id into host_id;
  return jsonb_build_object('host_id',host_id,'hostname',p_hostname,'txt_name','_htp-verification.'||p_hostname,'txt_value','htp-verification='||token);
end $$;

-- A staging hold may have revoked these. Apply this entire migration in a
-- verified single transaction, so the capped function is installed before
-- authenticated execution is restored. Service-only completion is unchanged.
revoke all on function public.begin_form_host_verification(uuid,text) from public, anon, authenticated;
grant execute on function public.begin_form_host_verification(uuid,text) to authenticated;
revoke all on function public.form_host_challenge(uuid) from public, anon, authenticated;
grant execute on function public.form_host_challenge(uuid) to authenticated;
