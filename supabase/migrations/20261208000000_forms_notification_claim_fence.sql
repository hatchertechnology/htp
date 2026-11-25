-- Worker fence only. Default empty/closed; no producers, backfill, activation or grants.
-- Rollout MUST quiesce all legacy callers and drain/reconcile issued leases before
-- replacement (including transactions already executing the old function body).
-- Close with approval -> website -> admission locks, then active=false; retain
-- this function on rollback. Restoring the legacy global claimant can send queued
-- unlabeled/stale/cross-site work even without approval. Never use that rollback.
-- Each reopening uses a fresh generation; never relabel old jobs automatically.
-- Producer/owner/confirmation lock audit and hosted activation belong to successors.
begin;
do $guard$
declare item record; p pg_proc; r text; reachable text;
begin
  for item in select * from (values
    ('public.claim_form_delivery()', 'f71b2931db18ad1147f6d966f60991004dd7542f3af29c6821a3dd1dcd19cc47'),
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

-- Private relations despite public schema placement: no policies or app access.
create table public.forms_notification_admissions (
  operation_id uuid not null,
  website_id uuid not null references public.websites(id) on delete restrict,
  owner_id uuid not null,
  generation uuid not null default gen_random_uuid(),
  active boolean not null default false,
  primary key(operation_id,website_id,owner_id),
  unique(website_id)
);
create table public.forms_notification_job_admissions (
  job_id uuid primary key references public.website_form_delivery_jobs(id) on delete restrict,
  operation_id uuid not null,
  website_id uuid not null,
  owner_id uuid not null,
  generation uuid not null
);
-- Separate private labels avoid exposing mutable admission columns through any
-- pre-existing job table grants. Legacy jobs have no label and remain excluded.
-- No FK to current generation: rotation must retain historical labels/evidence.
alter table public.forms_notification_admissions owner to postgres;
alter table public.forms_notification_job_admissions owner to postgres;
alter table public.forms_notification_admissions enable row level security;
alter table public.forms_notification_job_admissions enable row level security;
revoke all on public.forms_notification_admissions, public.forms_notification_job_admissions
  from public,anon,authenticated,service_role;
do $private$
declare t regclass; r text; reachable text; c text; privilege text;
begin
  foreach t in array array['public.forms_notification_admissions'::regclass,
                           'public.forms_notification_job_admissions'::regclass] loop
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
create or replace function public.claim_form_delivery()
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  scope record; candidate record;
  job public.website_form_delivery_jobs%rowtype;
  recipient public.website_form_recipients%rowtype;
  response public.website_form_responses%rowtype;
  f public.website_forms%rowtype;
  reply_to text;
begin
  -- Discovery is not authorization. Explicit locks below recheck each predicate.
  -- One scope per website; stable order also covers multiple approved sites.
  for scope in select * from public.forms_notification_admissions
    where active order by website_id,operation_id,owner_id loop
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

    for candidate in
      select j.id,r.form_id,j.response_id,j.recipient_id
      from public.website_form_delivery_jobs j
      join public.forms_notification_job_admissions a on a.job_id=j.id
      join public.website_form_recipients r on r.id=j.recipient_id
      where a.operation_id=scope.operation_id and a.website_id=scope.website_id
        and a.owner_id=scope.owner_id and a.generation=scope.generation
        and r.website_id=scope.website_id and j.state='pending'
      order by j.created_at,j.id
    loop
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
commit;
