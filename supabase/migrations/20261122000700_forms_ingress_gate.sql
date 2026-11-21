-- A shared form-wide gate counts public HTTP attempts, including preflight,
-- malformed submissions and honeypot hits. It is not an IP identity control.
create table public.website_form_ingress_windows (
  form_id uuid primary key references public.website_forms(id) on delete cascade,
  started_at timestamptz not null default now(),
  count integer not null default 0 check (count >= 0)
);
alter table public.website_form_ingress_windows enable row level security;
revoke all on public.website_form_ingress_windows from public,anon,authenticated;
create function public.charge_form_ingress(p_form_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare attempt_count integer;
begin
  if not exists(select 1 from public.website_forms where id=p_form_id) then return 'unavailable'; end if;
  insert into public.website_form_ingress_windows(form_id,started_at,count) values(p_form_id,now(),1)
  on conflict(form_id) do update set
    started_at=case when public.website_form_ingress_windows.started_at<=now()-interval '10 minutes' then now() else public.website_form_ingress_windows.started_at end,
    count=case when public.website_form_ingress_windows.started_at<=now()-interval '10 minutes' then 1 else least(public.website_form_ingress_windows.count+1,301) end
  returning count into attempt_count;
  if attempt_count>300 then return 'rate_limited'; end if;
  return 'ok';
end $$;
revoke all on function public.charge_form_ingress(uuid) from public,anon,authenticated;
grant execute on function public.charge_form_ingress(uuid) to service_role;
