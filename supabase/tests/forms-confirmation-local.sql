-- Disposable PostgreSQL only: minimal schema for the confirmation transaction.
create role anon; create role authenticated; create role service_role;
create table public.websites(id uuid primary key, owner_id uuid not null);
create table public.forms_pilot_approved_sites(website_id uuid primary key, owner_id uuid not null);
create table public.website_form_recipients(id uuid primary key, website_id uuid not null, enabled boolean default true, verified_at timestamptz, challenge_expires_at timestamptz, challenge_hash text);
create function public.forms_pilot_site_allowed(p_website_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
begin
  perform 1 from public.forms_pilot_approved_sites a
    join public.websites w on w.id=a.website_id and w.owner_id=a.owner_id
    where a.website_id=p_website_id for share of a,w;
  return found;
end $$;
revoke all on function public.forms_pilot_site_allowed(uuid) from public,anon,authenticated,service_role;

create function public.confirm_form_recipient(p_recipient_id uuid,p_token text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_token !~ '^[0-9a-f]{64}$' then return false; end if;
  update public.website_form_recipients set verified_at=now() where id=p_recipient_id and enabled and verified_at is null and challenge_expires_at>now() and challenge_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  return found;
end $$;
revoke all on function public.confirm_form_recipient(uuid,text) from public,anon,authenticated;
grant execute on function public.confirm_form_recipient(uuid,text) to service_role;
\i /tmp/confirm-migration.sql
insert into websites values ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');
insert into website_form_recipients values ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111',true,null,now()+interval '1 day',encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex'));
do $$
begin
  assert not confirm_form_recipient('33333333-3333-3333-3333-333333333333',repeat('a',64)), 'unapproved';
  insert into forms_pilot_approved_sites select id,owner_id from websites;
  update websites set owner_id='44444444-4444-4444-4444-444444444444';
  assert not confirm_form_recipient('33333333-3333-3333-3333-333333333333',repeat('a',64)), 'transferred';
  update websites set owner_id='22222222-2222-2222-2222-222222222222';
  assert not confirm_form_recipient('33333333-3333-3333-3333-333333333333',repeat('b',64)), 'wrong token';
  update website_form_recipients set enabled=false;
  assert not confirm_form_recipient('33333333-3333-3333-3333-333333333333',repeat('a',64)), 'disabled';
  update website_form_recipients set enabled=true,challenge_expires_at=now()-interval '1 second';
  assert not confirm_form_recipient('33333333-3333-3333-3333-333333333333',repeat('a',64)), 'expired';
  update website_form_recipients set challenge_expires_at=now()+interval '1 day';
  assert confirm_form_recipient('33333333-3333-3333-3333-333333333333',repeat('a',64)), 'valid';
  assert not confirm_form_recipient('33333333-3333-3333-3333-333333333333',repeat('a',64)), 'single use';
  assert not has_function_privilege('anon','public.confirm_form_recipient(uuid,text)','execute');
  assert not has_function_privilege('authenticated','public.confirm_form_recipient(uuid,text)','execute');
  assert has_function_privilege('service_role','public.confirm_form_recipient(uuid,text)','execute');
end $$;
