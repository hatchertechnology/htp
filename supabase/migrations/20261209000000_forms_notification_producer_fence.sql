-- Source-only successor. No activation, backfill, role grants, claim or finish changes.
-- Scope lock order: approval -> website -> admission -> existing labels -> form
-- -> response -> recipient -> jobs. New labels are inserted with new jobs only.
-- Supported submission entry point prelocks admission before form; trigger alone
-- is not an authorization API. Privileged arbitrary DML must follow this protocol.
-- Close takes approval, website, admission in that order. Fresh generation on reopen.
begin;
do $guard$
declare item record; p pg_proc; r text; reachable text;
begin
 for item in select * from (values
 ('public.forms_pilot_site_allowed(uuid)','b666743e3ecffb46d748773c047690991131a5d65850b6d94c20b5bf9295b5c1'),
 ('public.request_form_recipient(uuid,uuid,text)','3366cdb527c0f6f8ff61f0f045c331032738cca706f2539771191d7824375e96'),
 ('public.disable_form_recipient(uuid,uuid,uuid)','f6ee41cf1f36443e91ab4db324515606c4d5472a0b172715262e3ec4b4d9ff13'),
 ('public.retry_form_delivery(uuid,uuid,uuid)','8acb110d505f87ef94c921e365c700588f6eff2bd1191fc40f7a1e27465ad034'),
 ('public.delete_website_form_response(uuid,uuid,uuid)','24117385a227d9a8d249935606102f9e892825031d95a05e2100cd38ab880ea3'),
 ('public.accept_website_form(uuid,uuid,text,jsonb)','80fc4047e074f7a52c8c6b14f8137aa71c556a586ec1f871470c636791e5f432'),
 ('public.confirm_form_recipient(uuid,text)','66d2ad5a4d8d9ade7f9bf3c5747fd17e24ad148242ecae65c76cf3f729de4abf'),
 ('public.queue_form_response_notifications()','7d3ceebb715c241c4bed1b301559145d0401163e2b25718a7e1e10e8db784572')
 ,('public.guard_website_form_deletion()','df8e40294bb0016bb26ccbcb6e9da798916034aa6559ac43e537d910a5e2e319')
 ) v(signature,digest) loop
 select * into p from pg_proc where oid=to_regprocedure(item.signature);
 if p.oid is null or p.proowner <> 'postgres'::regrole or not p.prosecdef
 or p.prolang <> (select oid from pg_language where lanname='plpgsql')
 or p.proconfig is distinct from array['search_path=""']::text[]
 or encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') <> item.digest then
 raise exception 'notification_producer_source_drift: %',item.signature; end if;
 if (select count(*) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))) <> (case when item.signature='public.forms_pilot_site_allowed(uuid)' then 1 else 2 end)
 or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 where a.grantor<>'postgres'::regrole or a.grantee not in ('postgres'::regrole,'service_role'::regrole) or a.is_grantable or a.privilege_type<>'EXECUTE') then
 raise exception 'notification_producer_acl_drift'; end if;
 foreach r in array array['anon','authenticated','service_role'] loop
 for reachable in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
 if pg_has_role(reachable,'postgres','MEMBER') or has_function_privilege(reachable,p.oid,'EXECUTE') <> (r='service_role' and item.signature<>'public.forms_pilot_site_allowed(uuid)') then
 raise exception 'notification_producer_effective_acl_drift'; end if;
 end loop; end loop;
 end loop;
end $guard$;
create function public.forms_notification_scope(p_website_id uuid)
returns public.forms_notification_admissions language plpgsql security definer set search_path='' as $$
declare approved_owner uuid; scope public.forms_notification_admissions%rowtype;
begin
 select owner_id into approved_owner from public.forms_pilot_approved_sites where website_id=p_website_id for share;
 if not found then return null; end if;
 perform 1 from public.websites where id=p_website_id and owner_id=approved_owner for share;
 if not found then return null; end if;
 select * into scope from public.forms_notification_admissions where website_id=p_website_id and owner_id=approved_owner for share;
 if not found or not scope.active then return null; end if;
 return scope;
end $$;
alter function public.forms_notification_scope(uuid) owner to postgres;
revoke all on function public.forms_notification_scope(uuid) from public,anon,authenticated,service_role;
create or replace function public.forms_pilot_site_allowed(p_website_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare approved_owner uuid;
begin
 select owner_id into approved_owner from public.forms_pilot_approved_sites where website_id=p_website_id for share;
 if not found then return false; end if;
 perform 1 from public.websites where id=p_website_id and owner_id=approved_owner for share;
 return found;
end $$;
create or replace function public.request_form_recipient(p_website_id uuid,p_form_id uuid,p_email text)
returns uuid language plpgsql security definer set search_path='' as $$
declare recipient uuid; token text; address text; scope public.forms_notification_admissions%rowtype;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists (select 1 from public.websites where id=p_website_id and owner_id=(select auth.uid())) then raise exception 'Website not found' using errcode='42501'; end if;
  scope:=public.forms_notification_scope(p_website_id);
  if scope.operation_id is null or scope.owner_id is distinct from (select auth.uid()) then raise exception 'Form not found' using errcode='42501'; end if;
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites w join public.website_forms f on f.website_id=w.id where w.id=p_website_id and f.id=p_form_id and w.owner_id=(select auth.uid())) then raise exception 'Form not found' using errcode='42501'; end if;
  perform 1 from public.website_forms where id=p_form_id and website_id=p_website_id for update;
  address:=lower(btrim(p_email));
  if address is null or octet_length(address) not between 3 and 254 or address ~ '[[:space:][:cntrl:]]' or address !~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~.-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$' or split_part(address,'@',1) ~ '(^\.|\.\.|\.$)' or length(split_part(address,'@',1))>64 then raise exception 'Invalid email' using errcode='22023'; end if;
  if exists(select 1 from public.website_form_recipients where form_id=p_form_id and email=address and created_at>now()-interval '5 minutes') then raise exception 'Please wait before requesting another verification email' using errcode='22023'; end if;
  if not exists(select 1 from public.website_form_recipients where form_id=p_form_id and email=address) and (select count(*) from public.website_form_recipients where form_id=p_form_id)>=20 then raise exception 'Recipient limit reached' using errcode='22023'; end if;
  -- Form serialization excludes claims while checking/replacing invitations.
  if exists(select 1 from public.website_form_delivery_jobs j join public.website_form_recipients r on r.id=j.recipient_id
    where r.form_id=p_form_id and r.email=address and j.kind='verification' and j.state='sending') then
    raise exception 'Verification outcome unresolved' using errcode='55000'; end if;
  token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  insert into public.website_form_recipients(website_id,form_id,email,challenge_hash,challenge_expires_at) values(p_website_id,p_form_id,address,encode(sha256(convert_to(token,'UTF8')),'hex'),now()+interval '1 day')
    on conflict(form_id,email) do update set challenge_hash=excluded.challenge_hash,challenge_expires_at=excluded.challenge_expires_at,verified_at=null,enabled=true,created_at=now() returning id into recipient;
  update public.website_form_delivery_jobs set state='cancelled',secret_token=null,lease=null,leased_until=null,updated_at=now() where recipient_id=recipient and kind='verification' and state in ('pending','failed');
  with inserted as (
    insert into public.website_form_delivery_jobs(recipient_id,kind,secret_token) values(recipient,'verification',token) returning id
  ) insert into public.forms_notification_job_admissions
    select id,scope.operation_id,scope.website_id,scope.owner_id,scope.generation from inserted;
  return recipient;
end $$;
create or replace function public.disable_form_recipient(p_website_id uuid,p_form_id uuid,p_recipient_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare scope public.forms_notification_admissions%rowtype;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists (select 1 from public.websites where id=p_website_id and owner_id=(select auth.uid())) then raise exception 'Website not found' using errcode='42501'; end if;
  scope:=public.forms_notification_scope(p_website_id);
  if scope.operation_id is null or scope.owner_id is distinct from (select auth.uid()) then raise exception 'Recipient not found' using errcode='42501'; end if;
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites w join public.website_forms f on f.website_id=w.id where w.id=p_website_id and f.id=p_form_id and w.owner_id=(select auth.uid())) then raise exception 'Recipient not found' using errcode='42501'; end if;
  perform 1 from public.website_forms where id=p_form_id and website_id=p_website_id for update;
  if not found then raise exception 'Recipient not found' using errcode='42501'; end if;
  update public.website_form_recipients set enabled=false where id=p_recipient_id and website_id=p_website_id and form_id=p_form_id;
  if not found then raise exception 'Recipient not found' using errcode='42501'; end if;
  update public.website_form_delivery_jobs set state='cancelled',secret_token=null,updated_at=now() where recipient_id=p_recipient_id and state in ('pending','failed') and id in
    (select job_id from public.forms_notification_job_admissions where operation_id=scope.operation_id
      and website_id=scope.website_id and owner_id=scope.owner_id and generation=scope.generation);
  return true;
end $$;
create or replace function public.retry_form_delivery(p_website_id uuid,p_form_id uuid,p_job_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare scope public.forms_notification_admissions%rowtype; j public.website_form_delivery_jobs%rowtype;
begin
 if (select auth.jwt()->>'is_anonymous') is distinct from 'false' then raise exception 'Delivery not found' using errcode='42501'; end if;
 scope:=public.forms_notification_scope(p_website_id);
 if scope.operation_id is null or scope.owner_id is distinct from (select auth.uid()) then raise exception 'Delivery not found' using errcode='42501'; end if;
 perform 1 from public.forms_notification_job_admissions where job_id=p_job_id and operation_id=scope.operation_id
 and website_id=scope.website_id and owner_id=scope.owner_id and generation=scope.generation for share;
 if not found then return false; end if;
 perform 1 from public.website_forms where id=p_form_id and website_id=p_website_id for update;
 if not found then return false; end if;
 select * into j from public.website_form_delivery_jobs where id=p_job_id;
 if j.response_id is not null then
 perform 1 from public.website_form_responses where id=j.response_id and form_id=p_form_id and website_id=p_website_id for share;
 if not found then return false; end if; end if;
 perform 1 from public.website_form_recipients where id=j.recipient_id and website_id=p_website_id and form_id=p_form_id and enabled
 and ((j.kind='response' and verified_at is not null) or (j.kind='verification' and verified_at is null and challenge_expires_at>clock_timestamp() and j.secret_token is not null)) for share;
 if not found then return false; end if;
 update public.website_form_delivery_jobs set state='pending',updated_at=now() where id=p_job_id and state='failed'
 and recipient_id=j.recipient_id and response_id is not distinct from j.response_id and kind=j.kind;
 return found;
end $$;
create or replace function public.confirm_form_recipient(p_recipient_id uuid,p_token text)
returns boolean language plpgsql security definer set search_path='' as $$
declare r public.website_form_recipients%rowtype; scope public.forms_notification_admissions%rowtype;
begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return false; end if;
 select * into r from public.website_form_recipients where id=p_recipient_id;
 if not found then return false; end if;
 scope:=public.forms_notification_scope(r.website_id);
 if scope.operation_id is null then return false; end if;
 -- Immutable labels precede form/content locks, as in claim and deletion.
 perform 1 from public.forms_notification_job_admissions l join public.website_form_delivery_jobs j on j.id=l.job_id
 where j.recipient_id=r.id and j.kind='verification' and j.state in ('pending','sending','sent')
 and l.operation_id=scope.operation_id and l.website_id=scope.website_id and l.owner_id=scope.owner_id and l.generation=scope.generation
 order by l.job_id for share of l;
 if not found then return false; end if;
 perform 1 from public.website_forms where id=r.form_id and website_id=r.website_id for share;
 if not found then return false; end if;
 update public.website_form_recipients set verified_at=now() where id=r.id and website_id=r.website_id and form_id=r.form_id and enabled
 and verified_at is null and challenge_expires_at>clock_timestamp() and challenge_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 return found;
end $$;
create or replace function public.queue_form_response_notifications() returns trigger language plpgsql security definer set search_path='' as $$
declare scope public.forms_notification_admissions%rowtype; r record; job uuid;
begin
 scope:=public.forms_notification_scope(new.website_id);
 if scope.operation_id is null then return new; end if;
 perform 1 from public.website_forms where id=new.form_id and website_id=new.website_id for share;
 if not found then return new; end if;
 for r in select id from public.website_form_recipients where website_id=new.website_id and form_id=new.form_id
 and enabled and verified_at is not null order by id for share loop
 insert into public.website_form_delivery_jobs(recipient_id,response_id,kind) values(r.id,new.id,'response') on conflict do nothing returning id into job;
 if found then insert into public.forms_notification_job_admissions values(job,scope.operation_id,scope.website_id,scope.owner_id,scope.generation); end if;
 end loop;
 return new;
end $$;
create or replace function public.accept_website_form(p_form_id uuid, p_submission_id uuid, p_host text, p_values jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.website_forms%rowtype;
  existing public.website_form_responses%rowtype;
  field jsonb; k text; v text; errors jsonb := '{}'::jsonb; window_row public.website_form_rate_windows%rowtype;
begin
  if not public.forms_pilot_site_allowed((select website_id from public.website_forms where id=p_form_id)) then return jsonb_build_object('error','form_unavailable'); end if;
  -- Acquire admission before form even when closed: contact submission continues.
  perform public.forms_notification_scope((select website_id from public.website_forms where id=p_form_id));
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
create or replace function public.delete_website_form_response(p_website_id uuid,p_form_id uuid,p_response_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare response public.website_form_responses%rowtype;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists (select 1 from public.websites where id=p_website_id and owner_id=(select auth.uid())) then raise exception 'Website not found' using errcode='42501'; end if;
  if not public.forms_pilot_site_allowed(p_website_id) then raise exception 'Response not found' using errcode='42501'; end if;
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites where id=p_website_id and owner_id=(select auth.uid())) then raise exception 'Response not found' using errcode='42501'; end if;
  -- Lock labels first, matching claim. Preserve evidence until sending finishes.
  perform 1 from public.forms_notification_job_admissions l join public.website_form_delivery_jobs j on j.id=l.job_id
    join public.website_form_responses r on r.id=j.response_id
    where r.id=p_response_id and r.website_id=p_website_id and r.form_id=p_form_id order by l.job_id for update of l;
  perform 1 from public.website_forms where id=p_form_id and website_id=p_website_id for update;
  if not found then raise exception 'Response not found' using errcode='42501'; end if;
  -- A submission may have committed new labels while we waited for the form.
  -- Acquire those without waiting backwards behind a claimant holding a label.
  perform 1 from public.forms_notification_job_admissions l join public.website_form_delivery_jobs j on j.id=l.job_id
    where j.response_id=p_response_id order by l.job_id for update of l nowait;
  select * into response from public.website_form_responses where id=p_response_id and website_id=p_website_id and form_id=p_form_id for update;
  if not found then raise exception 'Response not found' using errcode='42501'; end if;
  perform 1 from public.website_form_delivery_jobs where response_id=p_response_id for update;
  if exists(select 1 from public.website_form_delivery_jobs where response_id=p_response_id and state='sending') then raise exception 'A notification is currently sending; try again later' using errcode='55000'; end if;
  insert into public.website_form_submission_tombstones(form_id,submission_id,value_hash) values(response.form_id,response.submission_id,encode(sha256(convert_to(response.values::text,'UTF8')),'hex')) on conflict do nothing;
  delete from public.forms_notification_job_admissions where job_id in (select id from public.website_form_delivery_jobs where response_id=p_response_id);
  delete from public.website_form_delivery_jobs where response_id=p_response_id;
  delete from public.website_form_responses where id=p_response_id;
  return true;
end $$;
create or replace function public.guard_website_form_deletion() returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- Website DELETE already owns the website row. Never wait backwards for
  -- approval: NOWAIT converts a competing claimant/closer into atomic refusal.
  perform 1 from public.forms_pilot_approved_sites where website_id=old.id for update nowait;
  perform 1 from public.forms_notification_admissions where website_id=old.id for update;
  if exists(select 1 from public.forms_notification_admissions where website_id=old.id and active) then
    raise exception 'Close notification admission before deleting website' using errcode='55000'; end if;
  if exists(select 1 from public.website_form_responses where website_id=old.id) then raise exception 'Delete or export collected form responses before deleting this website' using errcode='23503'; end if;
  perform 1 from public.website_form_delivery_jobs j join public.website_form_recipients r on r.id=j.recipient_id where r.website_id=old.id for update of j;
  if exists(select 1 from public.website_form_delivery_jobs j join public.website_form_recipients r on r.id=j.recipient_id where r.website_id=old.id and j.state='sending') then raise exception 'A form notification is currently sending' using errcode='23503'; end if;
  delete from public.forms_notification_job_admissions where job_id in
    (select j.id from public.website_form_delivery_jobs j join public.website_form_recipients r on r.id=j.recipient_id where r.website_id=old.id);
  delete from public.forms_notification_admissions where website_id=old.id;
  delete from public.website_form_delivery_jobs j using public.website_form_recipients r where j.recipient_id=r.id and r.website_id=old.id;
  delete from public.website_form_recipients where website_id=old.id;
  delete from public.website_form_origins where website_id=old.id;
  delete from public.website_form_submission_tombstones t using public.website_forms f where t.form_id=f.id and f.website_id=old.id;
  delete from public.website_forms where website_id=old.id;
  delete from public.website_form_hosts where website_id=old.id;
  return old;
end $$;
-- Preserve effective helper privacy even in the presence of inherited roles or
-- altered default privileges. Existing function ACLs are never regranted here.
do $private$
declare r text; reachable text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
 for reachable in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
 if pg_has_role(reachable,'postgres','MEMBER') or has_function_privilege(reachable,'public.forms_notification_scope(uuid)','EXECUTE') then
 raise exception 'notification_producer_helper_acl_drift'; end if;
 end loop; end loop;
end $private$;
commit;
