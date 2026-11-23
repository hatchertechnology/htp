-- DISPOSABLE PROTOTYPE ROLLBACK ONLY; not a hosted procedure.
begin;
do $$ begin if current_setting('forms.pilot_fixture',true) is distinct from 'disposable' then raise exception 'fixture_only'; end if; end $$;
-- Close service ingress/completion before restoring ungated bodies; assert
-- effective denial so inherited grants cause a transaction rollback.
revoke execute on function public.accept_website_form(uuid,uuid,text,jsonb), public.website_form_origin_allowed(uuid,text), public.complete_form_host_verification(uuid,text) from public,anon,authenticated,service_role;
do $$ declare r text; reachable_role text; n text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    for reachable_role in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
      foreach n in array array['public.accept_website_form(uuid,uuid,text,jsonb)','public.website_form_origin_allowed(uuid,text)','public.complete_form_host_verification(uuid,text)'] loop
        if has_function_privilege(reachable_role,n,'execute') then raise exception 'service_hold_drift'; end if;
      end loop;
    end loop;
  end loop;
end $$;
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

create or replace function public.form_host_challenge(p_host_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  select jsonb_build_object('hostname',h.hostname,'challenge_hash',h.challenge_hash) into result
  from public.website_form_hosts h join public.websites w on w.id=h.website_id
  where h.id=p_host_id and w.owner_id=(select auth.uid()) and (select auth.jwt()->>'is_anonymous')='false';
  if result is null then raise exception 'Host not found' using errcode='42501'; end if;
  return result;
end $$;

create or replace function public.complete_form_host_verification(p_host_id uuid,p_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.website_form_hosts set verified_at=now() where id=p_host_id and challenge_hash=p_hash and created_at > now()-interval '1 day';
  return found;
end $$;

create or replace function public.save_website_form(p_website_id uuid,p_form_id uuid,p_form_key text,p_name text,p_fields jsonb,p_active boolean,p_host_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare field jsonb; k text; seen text[] := '{}'; result public.website_forms%rowtype; host uuid;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites where id=p_website_id and owner_id=(select auth.uid())) then
    raise exception 'Website not found' using errcode='42501';
  end if;
  if p_form_key is null or p_form_key !~ '^[a-z][a-z0-9_]{0,63}$' or p_name is null or length(btrim(p_name)) not between 1 and 100 or jsonb_typeof(p_fields) is distinct from 'array' or jsonb_array_length(p_fields) not between 1 and 32 or p_active is null or p_host_ids is null or cardinality(p_host_ids)>16 then
    raise exception 'Invalid form' using errcode='22023';
  end if;
  for field in select * from jsonb_array_elements(p_fields) loop
    k:=field->>'key';
    if jsonb_typeof(field) is distinct from 'object' or k is null or k !~ '^[a-z][a-z0-9_]{0,63}$' or k=any(seen) or k in ('website','submission_id') or field->>'kind' not in ('text','email','telephone','multiline') or field->>'kind' is null or jsonb_typeof(field->'required') is distinct from 'boolean' or coalesce(field->>'max_length','') !~ '^[1-9][0-9]{0,3}$' or (field->>'max_length')::int>5000 or coalesce(length(btrim(field->>'label')),0) not between 1 and 100 or exists(select 1 from jsonb_object_keys(field) key where key not in ('key','kind','required','max_length','label')) then
      raise exception 'Invalid field definition' using errcode='22023';
    end if;
    seen:=array_append(seen,k);
  end loop;
  if p_active and cardinality(p_host_ids)=0 then raise exception 'Active form needs a verified host' using errcode='22023'; end if;
  if cardinality(p_host_ids)<>(select count(distinct x) from unnest(p_host_ids) x) then raise exception 'Invalid hosts' using errcode='22023'; end if;
  foreach host in array p_host_ids loop
    if not exists(select 1 from public.website_form_hosts where id=host and website_id=p_website_id and verified_at is not null) then raise exception 'Host not found or not verified' using errcode='22023'; end if;
  end loop;
  if p_form_id is null then
    insert into public.website_forms(website_id,form_key,name,fields,active) values(p_website_id,p_form_key,btrim(p_name),p_fields,p_active) returning * into result;
  else
    update public.website_forms set form_key=p_form_key,name=btrim(p_name),fields=p_fields,active=p_active where id=p_form_id and website_id=p_website_id returning * into result;
    if not found then raise exception 'Form not found' using errcode='42501'; end if;
    delete from public.website_form_origins where form_id=p_form_id;
  end if;
  insert into public.website_form_origins(website_id,form_id,host_id) select p_website_id,result.id,x from unnest(p_host_ids) x;
  return to_jsonb(result);
end $$;

create or replace function public.set_website_form_response_status(p_website_id uuid,p_form_id uuid,p_response_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result public.website_form_responses%rowtype;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites where id=p_website_id and owner_id=(select auth.uid())) then raise exception 'Response not found' using errcode='42501'; end if;
  if p_status is null or p_status not in ('new','reviewed','spam') then raise exception 'Invalid status' using errcode='22023'; end if;
  update public.website_form_responses set status=p_status where id=p_response_id and form_id=p_form_id and website_id=p_website_id returning * into result;
  if not found then raise exception 'Response not found' using errcode='42501'; end if;
  return to_jsonb(result);
end $$;

create or replace function public.request_form_recipient(p_website_id uuid,p_form_id uuid,p_email text)
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

create or replace function public.disable_form_recipient(p_website_id uuid,p_form_id uuid,p_recipient_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites w join public.website_forms f on f.website_id=w.id where w.id=p_website_id and f.id=p_form_id and w.owner_id=(select auth.uid())) then raise exception 'Recipient not found' using errcode='42501'; end if;
  update public.website_form_recipients set enabled=false where id=p_recipient_id and website_id=p_website_id and form_id=p_form_id;
  if not found then raise exception 'Recipient not found' using errcode='42501'; end if;
  update public.website_form_delivery_jobs set state='cancelled',secret_token=null,updated_at=now() where recipient_id=p_recipient_id and state in ('pending','failed');
  return true;
end $$;

create or replace function public.retry_form_delivery(p_website_id uuid,p_form_id uuid,p_job_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites w join public.website_forms f on f.website_id=w.id where w.id=p_website_id and f.id=p_form_id and w.owner_id=(select auth.uid())) then raise exception 'Delivery not found' using errcode='42501'; end if;
  update public.website_form_delivery_jobs j set state='pending',updated_at=now() from public.website_form_recipients r
    where j.id=p_job_id and j.recipient_id=r.id and r.website_id=p_website_id and r.form_id=p_form_id and r.enabled and (j.state='failed' or (j.state='uncertain' and j.kind='response')) and (j.kind='response' or (j.secret_token is not null and r.challenge_expires_at>now()));
  return found;
end $$;

create or replace function public.delete_website_form_response(p_website_id uuid,p_form_id uuid,p_response_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare response public.website_form_responses%rowtype;
begin
  if (select auth.jwt()->>'is_anonymous') is distinct from 'false' or not exists(select 1 from public.websites where id=p_website_id and owner_id=(select auth.uid())) then raise exception 'Response not found' using errcode='42501'; end if;
  perform 1 from public.website_forms where id=p_form_id and website_id=p_website_id for update;
  if not found then raise exception 'Response not found' using errcode='42501'; end if;
  select * into response from public.website_form_responses where id=p_response_id and website_id=p_website_id and form_id=p_form_id for update;
  if not found then raise exception 'Response not found' using errcode='42501'; end if;
  perform 1 from public.website_form_delivery_jobs where response_id=p_response_id for update;
  if exists(select 1 from public.website_form_delivery_jobs where response_id=p_response_id and state='sending') then raise exception 'A notification is currently sending; try again later' using errcode='55000'; end if;
  insert into public.website_form_submission_tombstones(form_id,submission_id,value_hash) values(response.form_id,response.submission_id,encode(sha256(convert_to(response.values::text,'UTF8')),'hex')) on conflict do nothing;
  delete from public.website_form_delivery_jobs where response_id=p_response_id;
  delete from public.website_form_responses where id=p_response_id;
  return true;
end $$;

create or replace function public.accept_website_form(p_form_id uuid, p_submission_id uuid, p_host text, p_values jsonb)
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

create or replace function public.website_form_origin_allowed(p_form_id uuid, p_host text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.website_forms f
    join public.website_form_origins o on o.form_id=f.id and o.website_id=f.website_id
    join public.website_form_hosts h on h.id=o.host_id and h.website_id=o.website_id
    where f.id=p_form_id and f.active and h.hostname=p_host and h.verified_at is not null)
$$;
revoke execute on function public.begin_form_host_verification(uuid,text),public.form_host_challenge(uuid),public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[]),public.set_website_form_response_status(uuid,uuid,uuid,text),public.request_form_recipient(uuid,uuid,text),public.disable_form_recipient(uuid,uuid,uuid),public.retry_form_delivery(uuid,uuid,uuid),public.delete_website_form_response(uuid,uuid,uuid) from public,anon,authenticated;
do $$ declare r text; reachable_role text; n text; begin
  foreach r in array array['anon','authenticated'] loop
    for reachable_role in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
      foreach n in array array['public.begin_form_host_verification(uuid,text)','public.form_host_challenge(uuid)','public.save_website_form(uuid,uuid,text,text,jsonb,boolean,uuid[])','public.set_website_form_response_status(uuid,uuid,uuid,text)','public.request_form_recipient(uuid,uuid,text)','public.disable_form_recipient(uuid,uuid,uuid)','public.retry_form_delivery(uuid,uuid,uuid)','public.delete_website_form_response(uuid,uuid,uuid)'] loop
        if has_function_privilege(reachable_role,n,'execute') then raise exception 'owner_hold_drift'; end if;
      end loop;
    end loop;
  end loop;
end $$;
drop function public.forms_pilot_site_allowed(uuid);
drop table public.forms_pilot_approved_sites;
commit;
