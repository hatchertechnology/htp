alter table public.websites add column ga4_property_id text;
alter table public.websites add constraint websites_ga4_property_id_check check (ga4_property_id is null or ga4_property_id ~ '^[1-9][0-9]{0,19}$');
grant update (ga4_property_id) on public.websites to authenticated;
comment on column public.websites.ga4_property_id is 'Numeric GA4 property used for this website; user OAuth is still required to read reports.';
