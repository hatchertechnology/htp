-- Foundation only: no public submission or authenticated write grants are
-- exposed by this migration. Later endpoints must enforce verification and
-- validation before introducing a write path.
create table public.website_form_hosts (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete restrict,
  hostname text not null,
  challenge_hash text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (website_id, hostname),
  constraint form_host_name_valid check (
    hostname = lower(hostname) and octet_length(hostname) between 3 and 253
    and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    and hostname !~ '\.[0-9]+$'
  )
);

create table public.website_forms (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id) on delete restrict,
  form_key text not null check (form_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  name text not null check (length(trim(name)) between 1 and 100),
  fields jsonb not null check (jsonb_typeof(fields) = 'array'),
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (website_id, form_key),
  unique (website_id, id)
);

create table public.website_form_responses (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null,
  form_id uuid not null,
  submission_id uuid not null,
  values jsonb not null check (jsonb_typeof(values) = 'object'),
  status text not null default 'new' check (status in ('new', 'reviewed', 'spam')),
  received_at timestamptz not null default now(),
  foreign key (website_id, form_id) references public.website_forms(website_id, id) on delete restrict,
  unique (form_id, submission_id)
);
create index website_form_responses_inbox_idx on public.website_form_responses (form_id, received_at desc, id);

alter table public.website_form_hosts enable row level security;
alter table public.website_forms enable row level security;
alter table public.website_form_responses enable row level security;
revoke all on public.website_form_hosts, public.website_forms, public.website_form_responses from public, anon, authenticated;
-- Challenge material and verified state are intentionally not client writable.
grant select (id, website_id, hostname, verified_at, created_at) on public.website_form_hosts to authenticated;
grant select on public.website_forms, public.website_form_responses to authenticated;
create policy form_hosts_owner_read on public.website_form_hosts for select to authenticated
  using (exists (select 1 from public.websites w where w.id = website_id and w.owner_id = (select auth.uid())) and (select auth.jwt()->>'is_anonymous') = 'false');
create policy forms_owner_read on public.website_forms for select to authenticated
  using (exists (select 1 from public.websites w where w.id = website_id and w.owner_id = (select auth.uid())) and (select auth.jwt()->>'is_anonymous') = 'false');
create policy form_responses_owner_read on public.website_form_responses for select to authenticated
  using (exists (select 1 from public.websites w where w.id = website_id and w.owner_id = (select auth.uid())) and (select auth.jwt()->>'is_anonymous') = 'false');
