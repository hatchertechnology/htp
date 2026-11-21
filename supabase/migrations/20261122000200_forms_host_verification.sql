-- Only a random server-generated challenge can establish control.
create function public.begin_form_host_verification(p_website_id uuid, p_hostname text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare token text; host_id uuid;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists (select 1 from public.websites where id=p_website_id and owner_id=(select auth.uid())) then
    raise exception 'Website not found' using errcode='42501';
  end if;
  if p_hostname is null or p_hostname <> lower(p_hostname) or octet_length(p_hostname) not between 3 and 253 or p_hostname !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' or p_hostname ~ '\.[0-9]+$' then
    raise exception 'Invalid hostname' using errcode='22023';
  end if;
  token := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into public.website_form_hosts(website_id,hostname,challenge_hash,verified_at)
    values(p_website_id,p_hostname,encode(sha256(convert_to(token,'UTF8')),'hex'),null)
    on conflict (website_id,hostname) do update set challenge_hash=excluded.challenge_hash,verified_at=null,created_at=now()
    returning id into host_id;
  return jsonb_build_object('host_id',host_id,'hostname',p_hostname,'txt_name','_htp-verification.'||p_hostname,'txt_value','htp-verification='||token);
end $$;
revoke all on function public.begin_form_host_verification(uuid,text) from public, anon;
grant execute on function public.begin_form_host_verification(uuid,text) to authenticated;

create function public.form_host_challenge(p_host_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  select jsonb_build_object('hostname',h.hostname,'challenge_hash',h.challenge_hash) into result
  from public.website_form_hosts h join public.websites w on w.id=h.website_id
  where h.id=p_host_id and w.owner_id=(select auth.uid()) and (select auth.jwt()->>'is_anonymous')='false';
  if result is null then raise exception 'Host not found' using errcode='42501'; end if;
  return result;
end $$;
revoke all on function public.form_host_challenge(uuid) from public, anon;
grant execute on function public.form_host_challenge(uuid) to authenticated;

-- Only the verifier using the server credential can mark the current challenge.
create function public.complete_form_host_verification(p_host_id uuid,p_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.website_form_hosts set verified_at=now() where id=p_host_id and challenge_hash=p_hash and created_at > now()-interval '1 day';
  return found;
end $$;
revoke all on function public.complete_form_host_verification(uuid,text) from public, anon, authenticated;
grant execute on function public.complete_form_host_verification(uuid,text) to service_role;
