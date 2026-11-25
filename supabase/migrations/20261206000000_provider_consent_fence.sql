-- Standalone: depends only on auth.users and the original Google/Bing connection tables.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
create table public.provider_consent_fences (
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google','bing')),
  epoch uuid not null default gen_random_uuid(),
  primary key (owner_id,provider)
);
alter table public.provider_consent_fences enable row level security;
revoke all on public.provider_consent_fences from public,anon,authenticated,service_role;
grant select,insert,update on public.provider_consent_fences to service_role;

-- Invoker functions deliberately require service_role's existing connection-table ACLs.
-- No definer escalation, owner-controlled JWT claims, dynamic SQL or public execution.
create function public.begin_provider_consent(p_owner_id uuid,p_provider text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare e uuid; g uuid;
begin
  if p_provider is null or p_provider not in ('google','bing') then raise exception 'invalid provider'; end if;
  insert into public.provider_consent_fences(owner_id,provider) values(p_owner_id,p_provider) on conflict do nothing;
  select epoch into strict e from public.provider_consent_fences where owner_id=p_owner_id and provider=p_provider for update;
  if p_provider='google' then select generation into g from public.google_connections where owner_id=p_owner_id;
  else select generation into g from public.bing_connections where owner_id=p_owner_id; end if;
  return jsonb_build_object('epoch',e,'generation',g);
end $$;

create function public.disconnect_provider_consent(p_owner_id uuid,p_provider text) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  perform public.begin_provider_consent(p_owner_id,p_provider);
  update public.provider_consent_fences set epoch=gen_random_uuid() where owner_id=p_owner_id and provider=p_provider;
  if p_provider='google' then
    insert into public.google_connections(owner_id,generation,encrypted_grant,scopes,status,updated_at)
      values(p_owner_id,gen_random_uuid(),'',array[]::text[],'disconnected',now())
      on conflict(owner_id) do update set generation=excluded.generation,encrypted_grant='',scopes=array[]::text[],status='disconnected',updated_at=now();
  else
    insert into public.bing_connections(owner_id,generation,encrypted_grant,status,updated_at)
      values(p_owner_id,gen_random_uuid(),'','disconnected',now())
      on conflict(owner_id) do update set generation=excluded.generation,encrypted_grant='',status='disconnected',updated_at=now();
  end if;
  return true;
end $$;

create function public.complete_provider_consent(p_owner_id uuid,p_provider text,p_epoch uuid,p_generation uuid,p_encrypted_grant text,p_scopes text[]) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare e uuid; n integer;
begin
  if p_provider is null or p_provider not in ('google','bing') then raise exception 'invalid provider'; end if;
  if p_encrypted_grant is null or length(p_encrypted_grant) not between 1 and 8192 or p_scopes is null then raise exception 'invalid grant'; end if;
  select epoch into e from public.provider_consent_fences where owner_id=p_owner_id and provider=p_provider for update;
  if not found or e is distinct from p_epoch then return false; end if;
  if p_provider='google' then
    if p_generation is null then
      insert into public.google_connections(owner_id,generation,encrypted_grant,scopes,status,updated_at)
        values(p_owner_id,gen_random_uuid(),p_encrypted_grant,p_scopes,'connected',now()) on conflict do nothing;
    else
      update public.google_connections set generation=gen_random_uuid(),encrypted_grant=p_encrypted_grant,scopes=p_scopes,status='connected',updated_at=now()
        where owner_id=p_owner_id and generation=p_generation;
    end if;
  else
    if p_generation is null then
      insert into public.bing_connections(owner_id,generation,encrypted_grant,status,updated_at)
        values(p_owner_id,gen_random_uuid(),p_encrypted_grant,'connected',now()) on conflict do nothing;
    else
      update public.bing_connections set generation=gen_random_uuid(),encrypted_grant=p_encrypted_grant,status='connected',updated_at=now()
        where owner_id=p_owner_id and generation=p_generation;
    end if;
  end if;
  get diagnostics n = row_count;
  if n<>1 then return false; end if;
  update public.provider_consent_fences set epoch=gen_random_uuid() where owner_id=p_owner_id and provider=p_provider;
  return true;
end $$;
revoke all on function public.begin_provider_consent(uuid,text),public.disconnect_provider_consent(uuid,text),public.complete_provider_consent(uuid,text,uuid,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.begin_provider_consent(uuid,text),public.disconnect_provider_consent(uuid,text),public.complete_provider_consent(uuid,text,uuid,uuid,text,text[]) to service_role;
notify pgrst, 'reload schema';
commit;
