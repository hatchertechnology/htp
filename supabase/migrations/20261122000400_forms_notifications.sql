create table public.website_form_recipients (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  form_id uuid not null,
  email text not null check (octet_length(email) between 3 and 254 and email !~ '[[:space:][:cntrl:]]' and email ~ '^[^@]+@[^@]+\.[^@]+$'),
  challenge_hash text not null,
  challenge_expires_at timestamptz not null,
  verified_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (website_id,form_id) references public.website_forms(website_id,id) on delete restrict,
  unique (form_id,email)
);
alter table public.website_form_recipients enable row level security;
revoke all on public.website_form_recipients from public,anon,authenticated;
grant select (id,website_id,form_id,email,verified_at,enabled,created_at) on public.website_form_recipients to authenticated;
create policy form_recipients_owner_read on public.website_form_recipients for select to authenticated
  using (exists(select 1 from public.websites w where w.id=website_id and w.owner_id=(select auth.uid())) and (select auth.jwt()->>'is_anonymous')='false');

create table public.website_form_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.website_form_recipients(id) on delete restrict,
  response_id uuid references public.website_form_responses(id) on delete restrict,
  kind text not null check (kind in ('verification','response')),
  secret_token text,
  state text not null default 'pending' check (state in ('pending','sending','sent','failed','uncertain','cancelled')),
  lease uuid,
  leased_until timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_kind_shape check ((kind='verification' and response_id is null) or (kind='response' and response_id is not null and secret_token is null)),
  unique (recipient_id,response_id)
);
alter table public.website_form_delivery_jobs enable row level security;
revoke all on public.website_form_delivery_jobs from public,anon,authenticated;
grant select (id,recipient_id,response_id,kind,state,attempts,created_at,updated_at) on public.website_form_delivery_jobs to authenticated;
create policy form_delivery_owner_read on public.website_form_delivery_jobs for select to authenticated
 using (exists(select 1 from public.website_form_recipients r join public.websites w on w.id=r.website_id where r.id=recipient_id and w.owner_id=(select auth.uid())) and (select auth.jwt()->>'is_anonymous')='false');

create function public.request_form_recipient(p_website_id uuid,p_form_id uuid,p_email text)
returns uuid language plpgsql security definer set search_path='' as $$
declare recipient uuid; token text; address text;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites w join public.website_forms f on f.website_id=w.id where w.id=p_website_id and f.id=p_form_id and w.owner_id=(select auth.uid())) then raise exception 'Form not found' using errcode='42501'; end if;
  perform 1 from public.website_forms where id=p_form_id and website_id=p_website_id for update;
  address:=lower(btrim(p_email));
  if address is null or octet_length(address) not between 3 and 254 or address ~ '[[:space:][:cntrl:]]' or address !~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~.-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' or split_part(address,'@',1) ~ '(^\.|\.\.|\.$)' or length(split_part(address,'@',1))>64 then raise exception 'Invalid email' using errcode='22023'; end if;
  if exists(select 1 from public.website_form_recipients where form_id=p_form_id and email=address and created_at>now()-interval '5 minutes') then raise exception 'Please wait before requesting another verification email' using errcode='22023'; end if;
  if not exists(select 1 from public.website_form_recipients where form_id=p_form_id and email=address) and (select count(*) from public.website_form_recipients where form_id=p_form_id)>=20 then raise exception 'Recipient limit reached' using errcode='22023'; end if;
  token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  insert into public.website_form_recipients(website_id,form_id,email,challenge_hash,challenge_expires_at) values(p_website_id,p_form_id,address,encode(sha256(convert_to(token,'UTF8')),'hex'),now()+interval '1 day')
    on conflict(form_id,email) do update set challenge_hash=excluded.challenge_hash,challenge_expires_at=excluded.challenge_expires_at,verified_at=null,enabled=true,created_at=now() returning id into recipient;
  update public.website_form_delivery_jobs set state='cancelled',secret_token=null,lease=null,leased_until=null,updated_at=now() where recipient_id=recipient and kind='verification' and state in ('pending','sending','failed');
  insert into public.website_form_delivery_jobs(recipient_id,kind,secret_token) values(recipient,'verification',token);
  return recipient;
end $$;
revoke all on function public.request_form_recipient(uuid,uuid,text) from public,anon;
grant execute on function public.request_form_recipient(uuid,uuid,text) to authenticated;

create function public.confirm_form_recipient(p_recipient_id uuid,p_token text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_token !~ '^[0-9a-f]{64}$' then return false; end if;
  update public.website_form_recipients set verified_at=now() where id=p_recipient_id and enabled and verified_at is null and challenge_expires_at>now() and challenge_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
  return found;
end $$;
revoke all on function public.confirm_form_recipient(uuid,text) from public,anon,authenticated;
grant execute on function public.confirm_form_recipient(uuid,text) to service_role;

create function public.queue_form_response_notifications() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.website_form_delivery_jobs(recipient_id,response_id,kind)
  select id,new.id,'response' from public.website_form_recipients where form_id=new.form_id and website_id=new.website_id and verified_at is not null and enabled on conflict do nothing;
  return new;
end $$;
revoke all on function public.queue_form_response_notifications() from public,anon,authenticated;
create trigger queue_form_response_notifications after insert on public.website_form_responses for each row execute function public.queue_form_response_notifications();

-- An expired lease is ambiguous: the provider may have accepted the message.
-- It is surfaced for owner review instead of automatically sending a duplicate.
create function public.claim_form_delivery()
returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.website_form_delivery_jobs%rowtype; recipient public.website_form_recipients%rowtype; response public.website_form_responses%rowtype; f public.website_forms%rowtype; reply_to text;
begin
  update public.website_form_delivery_jobs set state='uncertain',secret_token=null,lease=null,leased_until=null,updated_at=now() where state='sending' and leased_until<now();
  update public.website_form_delivery_jobs j set state='cancelled',secret_token=null,updated_at=now() from public.website_form_recipients r where j.recipient_id=r.id and j.state='pending' and ((j.kind='verification' and (not r.enabled or r.verified_at is not null or r.challenge_expires_at<=now())) or (j.kind='response' and (r.verified_at is null or not r.enabled)));
  select * into job from public.website_form_delivery_jobs where state='pending' order by created_at,id for update skip locked limit 1;
  if not found then return null; end if;
  update public.website_form_delivery_jobs set state='sending',lease=gen_random_uuid(),leased_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now() where id=job.id returning * into job;
  select * into recipient from public.website_form_recipients where id=job.recipient_id;
  select * into f from public.website_forms where id=recipient.form_id;
  if job.response_id is not null then
    select * into response from public.website_form_responses where id=job.response_id;
    select response.values->>(field->>'key') into reply_to from jsonb_array_elements(f.fields) field where field->>'kind'='email' and coalesce(response.values->>(field->>'key'),'')<>'' limit 1;
  end if;
  return jsonb_build_object('id',job.id,'lease',job.lease,'kind',job.kind,'recipient_id',recipient.id,'email',recipient.email,'token',job.secret_token,'form_name',f.name,'reply_to',reply_to);
end $$;
revoke all on function public.claim_form_delivery() from public,anon,authenticated;
grant execute on function public.claim_form_delivery() to service_role;

create function public.finish_form_delivery(p_job_id uuid,p_lease uuid,p_state text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_state not in ('sent','failed','uncertain') then raise exception 'Invalid state' using errcode='22023'; end if;
  update public.website_form_delivery_jobs set state=p_state,secret_token=case when p_state='failed' then secret_token else null end,lease=null,leased_until=null,updated_at=now()
    where id=p_job_id and state='sending' and lease=p_lease and leased_until>now();
  return found;
end $$;
revoke all on function public.finish_form_delivery(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.finish_form_delivery(uuid,uuid,text) to service_role;

create function public.retry_form_delivery(p_website_id uuid,p_form_id uuid,p_job_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites w join public.website_forms f on f.website_id=w.id where w.id=p_website_id and f.id=p_form_id and w.owner_id=(select auth.uid())) then raise exception 'Delivery not found' using errcode='42501'; end if;
  update public.website_form_delivery_jobs j set state='pending',updated_at=now() from public.website_form_recipients r
    where j.id=p_job_id and j.recipient_id=r.id and r.website_id=p_website_id and r.form_id=p_form_id and r.enabled and j.state='failed' and (j.kind='response' or (j.secret_token is not null and r.challenge_expires_at>now()));
  return found;
end $$;
revoke all on function public.retry_form_delivery(uuid,uuid,uuid) from public,anon;
grant execute on function public.retry_form_delivery(uuid,uuid,uuid) to authenticated;

create function public.disable_form_recipient(p_website_id uuid,p_form_id uuid,p_recipient_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites w join public.website_forms f on f.website_id=w.id where w.id=p_website_id and f.id=p_form_id and w.owner_id=(select auth.uid())) then raise exception 'Recipient not found' using errcode='42501'; end if;
  update public.website_form_recipients set enabled=false where id=p_recipient_id and website_id=p_website_id and form_id=p_form_id;
  if not found then raise exception 'Recipient not found' using errcode='42501'; end if;
  update public.website_form_delivery_jobs set state='cancelled',secret_token=null,updated_at=now() where recipient_id=p_recipient_id and state in ('pending','failed');
  return true;
end $$;
revoke all on function public.disable_form_recipient(uuid,uuid,uuid) from public,anon;
grant execute on function public.disable_form_recipient(uuid,uuid,uuid) to authenticated;
