-- Supabase projects may grant new functions directly to API roles by default.
-- Restrict user RPCs explicitly; owner checks remain mandatory inside each RPC.
revoke all on function public.import_seosmith_audit(uuid,text) from public,anon,authenticated;
grant execute on function public.import_seosmith_audit(uuid,text) to authenticated;
revoke all on function public.read_seosmith_audits(uuid,integer,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.read_seosmith_audits(uuid,integer,timestamptz,uuid) to authenticated;
revoke all on function public.seosmith_audit_history(uuid,integer,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.seosmith_audit_history(uuid,integer,timestamptz,uuid) to authenticated;
revoke all on function public.seosmith_audit_detail(uuid,uuid) from public,anon,authenticated;
grant execute on function public.seosmith_audit_detail(uuid,uuid) to authenticated;
-- Workers authenticate with the website-scoped secret, independently of user JWTs.
revoke all on function public.ingest_seosmith_audit(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.ingest_seosmith_audit(text,uuid,text,text) to anon;
