-- Authorize an export chunk without reserializing the audit report.
create function public.seosmith_audit_export_access(p_website_id uuid, p_delivery_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt()->>'is_anonymous','true') = 'false'
    and exists (
      select 1 from public.websites w
      join public.seosmith_audits a on a.website_id = w.id and a.fqdn = w.fqdn
      where w.id = p_website_id and w.owner_id = auth.uid()
        and a.delivery_id = p_delivery_id
    );
$$;
revoke all on function public.seosmith_audit_export_access(uuid,uuid) from public, anon;
grant execute on function public.seosmith_audit_export_access(uuid,uuid) to authenticated;
