-- Source-only successor; default closure and labels/claim payload unchanged.
-- Claim bounds: one cyclic active scope and 64 cyclic pending labels per call.
-- Fairness requires repeated committed calls, stable finite scopes/backlog and
-- eventual release of conflicting locks. Bounds cover rows visited/locked, not
-- planner work or wall time. UUID order intentionally replaces FIFO.
-- Keep this fence on rollback; close admissions, never restore global claim.
begin;
do $guard$
declare item record; p pg_proc; r text; reachable text;
begin
  for item in select * from (values
    ('public.claim_form_delivery()', '7dbabec80c8933d28246a2a3c115cd5f2caadb966b80edab40d6e3a1b3e3ab6d'),
    ('public.finish_form_delivery(uuid,uuid,text)', '05c7713d3df39c768bede655041d322d60c1ab82ef2908b86e081d6a369b3465')
  ) expected(signature, digest) loop
    select * into p from pg_proc where oid=to_regprocedure(item.signature);
    if p.oid is null or p.proowner <> 'postgres'::regrole or not p.prosecdef
      or p.prokind <> 'f' or p.prolang <> (select oid from pg_language where lanname='plpgsql')
      or p.prorettype <> (case when item.signature='public.claim_form_delivery()' then 'jsonb'::regtype else 'boolean'::regtype end)
      or p.proconfig is distinct from array['search_path=""']::text[]
      or encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') <> item.digest
    then raise exception 'notification_worker_function_drift'; end if;
    if (select count(*) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))) <> 2
      or exists (select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantor <> 'postgres'::regrole or a.grantee not in ('postgres'::regrole,'service_role'::regrole)
          or a.privilege_type <> 'EXECUTE' or a.is_grantable)
    then raise exception 'notification_worker_acl_drift'; end if;
    foreach r in array array['anon','authenticated','service_role'] loop
      for reachable in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
        if pg_has_role(reachable,'postgres','MEMBER')
          or (has_function_privilege(reachable,p.oid,'EXECUTE') <> (r='service_role'))
        then raise exception 'notification_worker_effective_acl_drift'; end if;
      end loop;
    end loop;
  end loop;
end $guard$;

create index forms_notification_labels_scope_job on public.forms_notification_job_admissions
  (operation_id,website_id,owner_id,generation,job_id);
create index forms_notification_pending_job on public.website_form_delivery_jobs(id) where state='pending';
create index forms_notification_active_scope on public.forms_notification_admissions(website_id) where active;
create table public.forms_notification_schedule (
  slot integer not null check(slot in (0,1)), website_cursor uuid,
  job_cursor uuid, unique nulls not distinct(slot,website_cursor)
);
-- Singleton mutex remains one row: slot zero is never inserted by functions.
insert into public.forms_notification_schedule values(0,null,null);
alter table public.forms_notification_schedule owner to postgres;
alter table public.forms_notification_schedule enable row level security;
revoke all on public.forms_notification_schedule from public,anon,authenticated,service_role;
create or replace function public.claim_form_delivery()
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  scope record; candidate record;
  job public.website_form_delivery_jobs%rowtype;
  recipient public.website_form_recipients%rowtype;
  response public.website_form_responses%rowtype;
  f public.website_forms%rowtype;
  reply_to text;
  cursor_site uuid; cursor_job uuid;
begin
  -- A private scheduler mutex is acquired before domain locks. No producer,
  -- closer or finish path accesses it. Concurrent callers return null, not wait.
  select website_cursor into cursor_site from public.forms_notification_schedule
    where slot=0 for update skip locked;
  if not found then return null; end if;
  for scope in select * from public.forms_notification_admissions
    where active order by coalesce(website_id<=cursor_site,false),website_id limit 1 loop
    update public.forms_notification_schedule set website_cursor=scope.website_id where slot=0;
    perform 1 from public.forms_pilot_approved_sites
      where website_id=scope.website_id and owner_id=scope.owner_id for share;
    if not found then continue; end if;
    perform 1 from public.websites
      where id=scope.website_id and owner_id=scope.owner_id for share;
    if not found then continue; end if;
    perform 1 from public.forms_notification_admissions
      where operation_id=scope.operation_id and website_id=scope.website_id
        and owner_id=scope.owner_id and generation=scope.generation and active for share;
    if not found then continue; end if;

    insert into public.forms_notification_schedule(slot,website_cursor,job_cursor)
      values (1,scope.website_id,null) on conflict do nothing;
    select job_cursor into cursor_job from public.forms_notification_schedule
      where slot=1 and website_cursor=scope.website_id;
    for candidate in
      select j.id,r.form_id,j.response_id,j.recipient_id
      from public.forms_notification_job_admissions a
      join public.website_form_delivery_jobs j on j.id=a.job_id
      left join public.website_form_recipients r on r.id=j.recipient_id
      where a.operation_id=scope.operation_id and a.website_id=scope.website_id
        and a.owner_id=scope.owner_id and a.generation=scope.generation and j.state='pending'
      order by coalesce(j.id<=cursor_job,false),j.id limit 64
    loop
      update public.forms_notification_schedule set job_cursor=candidate.id
        where slot=1 and website_cursor=scope.website_id;
      -- Private labels precede content locks. No job lock is held while waiting
      -- for form/response/recipient; compatible with existing producer order.
      perform 1 from public.forms_notification_job_admissions
        where job_id=candidate.id and operation_id=scope.operation_id
          and website_id=scope.website_id and owner_id=scope.owner_id
          and generation=scope.generation for share;
      if not found then continue; end if;
      select * into f from public.website_forms
        where id=candidate.form_id and website_id=scope.website_id for share;
      if not found then continue; end if;
      reply_to := null;
      if candidate.response_id is not null then
        select * into response from public.website_form_responses
          where id=candidate.response_id and website_id=scope.website_id
            and form_id=f.id for share;
        if not found then continue; end if;
      end if;
      select * into recipient from public.website_form_recipients
        where id=candidate.recipient_id and website_id=scope.website_id
          and form_id=f.id and enabled for share;
      if not found then continue; end if;
      select * into job from public.website_form_delivery_jobs
        where id=candidate.id and recipient_id=recipient.id
          and response_id is not distinct from candidate.response_id and state='pending'
          and ((kind='verification' and response_id is null and secret_token is not null
                and recipient.verified_at is null and recipient.challenge_expires_at>clock_timestamp())
            or (kind='response' and response_id is not null and recipient.verified_at is not null))
        for update skip locked;
      if not found then continue; end if;
      update public.website_form_delivery_jobs set state='sending',lease=gen_random_uuid(),
        leased_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1,
        updated_at=clock_timestamp() where id=job.id returning * into job;
      if job.response_id is not null then
        select response.values->>(field->>'key') into reply_to
          from jsonb_array_elements(f.fields) field where field->>'kind'='email'
            and coalesce(response.values->>(field->>'key'),'')<>'' limit 1;
      end if;
      return jsonb_build_object('id',job.id,'lease',job.lease,'kind',job.kind,
        'recipient_id',recipient.id,'email',recipient.email,'token',job.secret_token,
        'form_name',f.name,'reply_to',reply_to,'generation',scope.generation);
    end loop;
  end loop;
  -- No expiry/cancellation sweep, and no automatic retry. An expired sending
  -- attempt needs separately reviewed scoped reconciliation, including provider evidence.
  return null;
end $$;
-- Administrative maintenance only: no application EXECUTE, no activation.
-- Exact current generation only; historical generations require a separately
-- reviewed transition, never broadening this function to sweep old labels.
create function public.reconcile_form_delivery_scope(
 p_operation uuid,p_website uuid,p_owner uuid,p_generation uuid,p_limit integer default 64)
returns integer language plpgsql security definer set search_path='' as $$
declare c record; n integer:=0; admission_active boolean;
begin
 if p_limit is null or p_limit<1 or p_limit>64 then raise exception 'invalid maintenance bound'; end if;
 perform 1 from public.forms_pilot_approved_sites where website_id=p_website and owner_id=p_owner for share;
 if not found then return 0; end if;
 perform 1 from public.websites where id=p_website and owner_id=p_owner for share;
 if not found then return 0; end if;
 select active into admission_active from public.forms_notification_admissions where operation_id=p_operation
   and website_id=p_website and owner_id=p_owner and generation=p_generation for share;
 if not found then return 0; end if;
 for c in select a.job_id from public.forms_notification_job_admissions a
   join public.website_form_delivery_jobs j on j.id=a.job_id
   left join public.website_form_recipients r on r.id=j.recipient_id
   where a.operation_id=p_operation and a.website_id=p_website and a.owner_id=p_owner
     and a.generation=p_generation and r.website_id=p_website and
     ((j.state='sending' and j.leased_until<=clock_timestamp()) or
      (j.kind='verification' and j.secret_token is not null and j.state<>'sending'
       and (not admission_active or j.state<>'pending' or r.id is null or r.website_id<>p_website or not r.enabled
         or r.verified_at is not null or r.challenge_expires_at is null
         or r.challenge_expires_at<=clock_timestamp())))
   order by a.job_id limit p_limit
 loop
   perform 1 from public.forms_notification_job_admissions where job_id=c.job_id
     and operation_id=p_operation and website_id=p_website and owner_id=p_owner
     and generation=p_generation for share;
   if not found then continue; end if;
   -- No form/response content is read or locked. Recipient precedes job,
   -- compatible with claim and producer content -> recipient -> job order.
   perform 1 from public.website_form_recipients r join public.website_form_delivery_jobs j
     on j.recipient_id=r.id where j.id=c.job_id and r.website_id=p_website for share of r;
   if not found then continue; end if;
   perform 1 from public.website_form_delivery_jobs where id=c.job_id for update skip locked;
   if not found then continue; end if;
   update public.website_form_delivery_jobs j set
     state=case when j.state='sending' then 'uncertain' when j.state='pending' then 'cancelled' else j.state end,
     secret_token=null,updated_at=clock_timestamp()
     -- Preserve attempts, lease and expiry as outcome evidence. Finish requires
     -- sending, so the retained expired lease cannot finish or cause a resend.
     where j.id=c.job_id and
       ((j.state='sending' and j.leased_until<=clock_timestamp()) or
        (j.kind='verification' and j.secret_token is not null and j.state<>'sending'
         and (not admission_active or j.state<>'pending' or not exists(select 1 from public.website_form_recipients r
           where r.id=j.recipient_id and r.website_id=p_website and r.enabled
             and r.verified_at is null and r.challenge_expires_at>clock_timestamp()))));
   if found then n:=n+1; end if;
 end loop;
 return n;
end $$;
alter function public.reconcile_form_delivery_scope(uuid,uuid,uuid,uuid,integer) owner to postgres;
revoke all on function public.reconcile_form_delivery_scope(uuid,uuid,uuid,uuid,integer)
 from public,anon,authenticated,service_role;
do $guard$
declare item record; p pg_proc; r text; reachable text;
begin
  for item in select * from (values
    ('public.claim_form_delivery()', '84b2d5809a8e7fa4f671a51d996f996e02459fd4ba556147e422fe559fe3b8ee'),
    ('public.finish_form_delivery(uuid,uuid,text)', '05c7713d3df39c768bede655041d322d60c1ab82ef2908b86e081d6a369b3465')
  ) expected(signature, digest) loop
    select * into p from pg_proc where oid=to_regprocedure(item.signature);
    if p.oid is null or p.proowner <> 'postgres'::regrole or not p.prosecdef
      or p.prokind <> 'f' or p.prolang <> (select oid from pg_language where lanname='plpgsql')
      or p.prorettype <> (case when item.signature='public.claim_form_delivery()' then 'jsonb'::regtype else 'boolean'::regtype end)
      or p.proconfig is distinct from array['search_path=""']::text[]
      or encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') <> item.digest
    then raise exception 'notification_worker_function_drift'; end if;
    if (select count(*) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))) <> 2
      or exists (select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantor <> 'postgres'::regrole or a.grantee not in ('postgres'::regrole,'service_role'::regrole)
          or a.privilege_type <> 'EXECUTE' or a.is_grantable)
    then raise exception 'notification_worker_acl_drift'; end if;
    foreach r in array array['anon','authenticated','service_role'] loop
      for reachable in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
        if pg_has_role(reachable,'postgres','MEMBER')
          or (has_function_privilege(reachable,p.oid,'EXECUTE') <> (r='service_role'))
        then raise exception 'notification_worker_effective_acl_drift'; end if;
      end loop;
    end loop;
  end loop;
end $guard$;

do $private$
declare t regclass; r text; reachable text; c text; privilege text;
begin
  foreach t in array array['public.forms_notification_schedule'::regclass] loop
    foreach r in array array['anon','authenticated','service_role'] loop
      for reachable in select rolname from pg_roles where pg_has_role(r,oid,'MEMBER') loop
        if pg_has_role(reachable,'postgres','MEMBER') then raise exception 'notification_private_owner_drift'; end if;
        foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
          if has_table_privilege(reachable,t,privilege) then raise exception 'notification_private_acl_drift'; end if;
        end loop;
        for c in select attname from pg_attribute where attrelid=t and attnum>0 and not attisdropped loop
          foreach privilege in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
            if has_column_privilege(reachable,t,c,privilege) then raise exception 'notification_private_column_acl_drift'; end if;
          end loop;
        end loop;
      end loop;
    end loop;
  end loop;
end $private$;
do $acl$
declare r record;
begin
 for r in select oid from pg_roles where
   pg_has_role('anon',oid,'MEMBER') or pg_has_role('authenticated',oid,'MEMBER')
   or pg_has_role('service_role',oid,'MEMBER') loop
   if has_function_privilege(r.oid,
     'public.reconcile_form_delivery_scope(uuid,uuid,uuid,uuid,integer)','EXECUTE')
   then raise exception 'notification_maintenance_acl_drift'; end if;
 end loop;
end $acl$;
commit;
