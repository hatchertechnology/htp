-- Commit observations are website-owner scoped and never imply deployment.
create table public.website_repositories (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete cascade,
  fqdn text not null,
  repository_url text not null check (repository_url ~ '^https://github[.]com/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$' and repository_url !~ '/[.]{1,2}$'),
  branch text check (length(branch) between 1 and 255 and branch !~ '[[:cntrl:]]'),
  enabled boolean not null default true,
  attached_at timestamptz not null default now(),
  head_sha text,
  scan_ref text,
  scan_page integer not null default 1 check (scan_page > 0),
  next_run_at timestamptz not null default now(),
  last_checked_at timestamptz,
  last_error text,
  lease uuid,
  leased_until timestamptz
);
create unique index website_repositories_active on public.website_repositories(website_id,fqdn) where enabled;
create index website_repositories_due on public.website_repositories(next_run_at) where enabled;
create table public.website_repository_commits (
  id bigint generated always as identity primary key,
  repository_id uuid not null references public.website_repositories(id) on delete cascade,
  sha text not null check (sha ~ '^[0-9a-f]{40,64}$'),
  message text not null,
  author text,
  authored_at timestamptz,
  committed_at timestamptz not null,
  observed_at timestamptz not null default now(),
  unique(repository_id,sha)
);
create index website_repository_commits_history on public.website_repository_commits(repository_id,committed_at desc,id desc);
alter table public.website_repositories enable row level security;
alter table public.website_repository_commits enable row level security;
revoke all on public.website_repositories,public.website_repository_commits from public,anon,authenticated;
grant all on public.website_repositories,public.website_repository_commits to service_role;
revoke all on sequence public.website_repository_commits_id_seq from public,anon,authenticated;
grant usage,select on sequence public.website_repository_commits_id_seq to service_role;

create function public.set_website_repository(p_repository_url text,p_branch text default null,p_enabled boolean default true,p_website_id uuid default null,p_fqdn text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.websites; r public.website_repositories;
begin
  select * into w from public.websites where owner_id=auth.uid() and coalesce(auth.jwt()->>'is_anonymous','true')='false'
    and ((p_website_id is not null and id=p_website_id) or (p_website_id is null and fqdn=p_fqdn)) for no key update;
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  p_repository_url := regexp_replace(rtrim(btrim(p_repository_url),'/'),'[.]git$','');
  if p_enabled is null or (p_repository_url is not null and (p_repository_url !~ '^https://github[.]com/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$' or p_repository_url ~ '/[.]{1,2}$'))
    or (p_branch is not null and (length(p_branch) not between 1 and 255 or p_branch ~ '[[:cntrl:]]')) then
    raise invalid_parameter_value using message='Use a GitHub repository URL and an optional branch name'; end if;
  -- Pause/unlink preserves all rows. Editing a binding starts a new history stream.
  select * into r from public.website_repositories where website_id=w.id and fqdn=w.fqdn order by attached_at desc,id desc limit 1;
  update public.website_repositories set enabled=false,lease=null,leased_until=null where website_id=w.id and fqdn=w.fqdn;
  if p_repository_url is null then return jsonb_build_object('enabled',false); end if;
  if r.id is not null and r.repository_url=p_repository_url and r.branch is not distinct from p_branch then
    update public.website_repositories set enabled=p_enabled,next_run_at=now() where id=r.id returning * into r;
  else
    if (select count(*) from public.website_repositories where website_id=w.id)>=50 then raise program_limit_exceeded using message='Repository history limit reached'; end if;
    insert into public.website_repositories(website_id,fqdn,repository_url,branch,enabled) values(w.id,w.fqdn,p_repository_url,p_branch,p_enabled) returning * into r;
  end if;
  return jsonb_build_object('id',r.id,'repository_url',r.repository_url,'branch',r.branch,'enabled',r.enabled);
end $$;
revoke all on function public.set_website_repository(text,text,boolean,uuid,text) from public,anon;
grant execute on function public.set_website_repository(text,text,boolean,uuid,text) to authenticated;

create function public.website_repository_history(p_website_id uuid default null,p_fqdn text default null,p_start_date date default current_date-28,p_end_date date default current_date,p_before_id bigint default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w public.websites; r public.website_repositories; result jsonb; cursor_date timestamptz;
begin
  select * into w from public.websites where owner_id=auth.uid() and coalesce(auth.jwt()->>'is_anonymous','true')='false'
    and ((p_website_id is not null and id=p_website_id) or (p_website_id is null and fqdn=p_fqdn));
  if not found then raise insufficient_privilege using message='Website not found'; end if;
  if p_start_date is null or p_end_date is null or p_end_date<p_start_date or p_end_date-p_start_date>=366 or p_before_id<=0 then
    raise invalid_parameter_value using message='Choose at most 366 days'; end if;
  select * into r from public.website_repositories where website_id=w.id and fqdn=w.fqdn order by attached_at desc,id desc limit 1;
  if p_before_id is not null then
    select c.committed_at into cursor_date from public.website_repository_commits c join public.website_repositories b on b.id=c.repository_id
      where c.id=p_before_id and b.website_id=w.id and b.fqdn=w.fqdn;
    if not found then raise invalid_parameter_value using message='Invalid history cursor'; end if;
  end if;
  -- Resolve the opaque ID to a commit-date/ID cursor inside this owner's history.
  with page as (
    select c.id,c.sha,c.message,c.author,c.authored_at,c.committed_at,c.observed_at,b.repository_url,b.branch
    from public.website_repository_commits c join public.website_repositories b on b.id=c.repository_id
    where b.website_id=w.id and b.fqdn=w.fqdn and c.committed_at>=p_start_date::timestamp at time zone 'UTC'
      and c.committed_at<(p_end_date+1)::timestamp at time zone 'UTC' and (p_before_id is null or (c.committed_at,c.id)<(cursor_date,p_before_id))
    order by c.committed_at desc,c.id desc limit 101
  ) select jsonb_build_object('commits',coalesce((select jsonb_agg(to_jsonb(x) order by x.committed_at desc,x.id desc) from (select * from page order by committed_at desc,id desc limit 100) x),'[]'::jsonb),'has_more',count(*)>100) into result from page;
  return result || jsonb_build_object('fqdn',w.fqdn,'repository',case when r.id is null then null else jsonb_build_object(
    'id',r.id,'repository_url',r.repository_url,'branch',r.branch,'enabled',r.enabled,'attached_at',r.attached_at,
    'last_checked_at',r.last_checked_at,'last_error',r.last_error,'next_run_at',r.next_run_at,'backfilling',r.scan_ref is not null) end);
end $$;
revoke all on function public.website_repository_history(uuid,text,date,date,bigint) from public,anon;
grant execute on function public.website_repository_history(uuid,text,date,date,bigint) to authenticated;

create function public.claim_website_repository() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.website_repositories;
begin
  select b.* into r from public.website_repositories b join public.websites w on w.id=b.website_id and w.fqdn=b.fqdn
    where b.enabled and b.next_run_at<=now() and (b.leased_until is null or b.leased_until<now())
    order by b.next_run_at,b.id for update of b skip locked limit 1;
  if not found then return null; end if;
  update public.website_repositories set lease=gen_random_uuid(),leased_until=now()+interval '3 minutes' where id=r.id returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function public.claim_website_repository() from public,anon,authenticated;
grant execute on function public.claim_website_repository() to service_role;

create function public.complete_website_repository(p_id uuid,p_lease uuid,p_commits jsonb,p_scan_ref text,p_done boolean,p_error text default null,p_retry_seconds integer default 3600) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.website_repositories; w public.websites;
begin
  -- Lock the website first, matching edit/rename order and preventing late writes.
  select w0.* into w from public.websites w0 join public.website_repositories b on b.website_id=w0.id where b.id=p_id for no key update of w0;
  select * into r from public.website_repositories where id=p_id for update;
  if p_lease is null or r.lease is null or r.id is null or not r.enabled or r.fqdn<>w.fqdn or r.lease is distinct from p_lease or r.leased_until<now() then return false; end if;
  if p_error is null then
    if jsonb_typeof(p_commits)<>'array' or jsonb_array_length(p_commits)>100 or p_done is null or (p_scan_ref is not null and p_scan_ref !~ '^[0-9a-f]{40,64}$') then raise invalid_parameter_value; end if;
    insert into public.website_repository_commits(repository_id,sha,message,author,authored_at,committed_at)
      select r.id,x.sha,left(x.message,20000),left(x.author,256),x.authored_at,x.committed_at
      from jsonb_to_recordset(p_commits) as x(sha text,message text,author text,authored_at timestamptz,committed_at timestamptz)
      on conflict(repository_id,sha) do nothing;
    update public.website_repositories set
      head_sha=case when p_done then coalesce(p_scan_ref,head_sha) else head_sha end,
      scan_ref=case when p_done then null else p_scan_ref end,scan_page=case when p_done then 1 else scan_page+1 end,
      last_checked_at=now(),last_error=null,next_run_at=now()+case when p_done then interval '1 hour' else interval '1 minute' end,
      lease=null,leased_until=null where id=r.id;
  else
    update public.website_repositories set last_checked_at=now(),last_error=left(p_error,100),
      next_run_at=now()+make_interval(secs=>greatest(60,least(p_retry_seconds,86400))),lease=null,leased_until=null where id=r.id;
  end if;
  return true;
end $$;
revoke all on function public.complete_website_repository(uuid,uuid,jsonb,text,boolean,text,integer) from public,anon,authenticated;
grant execute on function public.complete_website_repository(uuid,uuid,jsonb,text,boolean,text,integer) to service_role;
