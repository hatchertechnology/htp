-- Service-only, globally serialized admission for API instances. Hashes are
-- keyed by the API, expire after ten minutes, and never contain raw addresses.
create table public.website_form_client_windows (
  client_hash text primary key check (client_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null,
  count integer not null check (count > 0)
);
alter table public.website_form_client_windows enable row level security;
revoke all on public.website_form_client_windows from public, anon, authenticated;
create table public.website_form_global_window (id boolean primary key default true check (id), started_at timestamptz not null, count integer not null);
alter table public.website_form_global_window enable row level security;
revoke all on public.website_form_global_window from public, anon, authenticated;
create function public.charge_form_client(p_hash text) returns text
language plpgsql security definer set search_path='' as $$
declare n integer; g integer;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return 'unavailable'; end if;
  perform pg_advisory_xact_lock(20261122000900);
  delete from public.website_form_client_windows where started_at <= now() - interval '10 minutes';
  insert into public.website_form_global_window(id,started_at,count) values(true,now(),1)
    on conflict(id) do update set started_at=case when public.website_form_global_window.started_at<=now()-interval '10 minutes' then now() else public.website_form_global_window.started_at end,
      count=case when public.website_form_global_window.started_at<=now()-interval '10 minutes' then 1 else least(public.website_form_global_window.count+1,10001) end returning count into g;
  if g>10000 then return 'rate_limited'; end if;
  if not exists(select 1 from public.website_form_client_windows where client_hash=p_hash) and (select count(*) from public.website_form_client_windows)>=10000 then return 'unavailable'; end if;
  insert into public.website_form_client_windows(client_hash,started_at,count) values(p_hash,now(),1)
    on conflict(client_hash) do update set count=least(public.website_form_client_windows.count+1,101) returning count into n;
  if n>100 then return 'rate_limited'; end if;
  return 'ok';
end $$;
revoke all on function public.charge_form_client(text) from public,anon,authenticated;
grant execute on function public.charge_form_client(text) to service_role;
