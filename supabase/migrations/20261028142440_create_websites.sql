-- Only fqdn is business data. IDs and ownership support stable URLs and access control.
create table public.websites (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  fqdn text not null,
  constraint websites_owner_fqdn_key unique (owner_id, fqdn),
  constraint websites_fqdn_valid check (
    octet_length(fqdn) between 3 and 253
    and fqdn = lower(fqdn)
    and fqdn ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    and fqdn !~ '\.[0-9]+$'
  )
);

alter table public.websites enable row level security;

revoke all on public.websites from public, anon, authenticated;
grant select, delete on public.websites to authenticated;
grant insert (fqdn), update (fqdn) on public.websites to authenticated;

create policy websites_select_own on public.websites for select to authenticated
  using ((select auth.uid()) = owner_id and (select auth.jwt()->>'is_anonymous') = 'false');
create policy websites_insert_own on public.websites for insert to authenticated
  with check ((select auth.uid()) = owner_id and (select auth.jwt()->>'is_anonymous') = 'false');
create policy websites_update_own on public.websites for update to authenticated
  using ((select auth.uid()) = owner_id and (select auth.jwt()->>'is_anonymous') = 'false')
  with check ((select auth.uid()) = owner_id and (select auth.jwt()->>'is_anonymous') = 'false');
create policy websites_delete_own on public.websites for delete to authenticated
  using ((select auth.uid()) = owner_id and (select auth.jwt()->>'is_anonymous') = 'false');
