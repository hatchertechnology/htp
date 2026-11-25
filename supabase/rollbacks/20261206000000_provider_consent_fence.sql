-- Hold native rollout and drain/restart pending consent before rollback.
-- Connection data, tombstones, generations and existing ACLs remain intact.
begin;
drop function public.complete_provider_consent(uuid,text,uuid,uuid,text,text[]);
drop function public.disconnect_provider_consent(uuid,text);
drop function public.begin_provider_consent(uuid,text);
drop table public.provider_consent_fences;
notify pgrst, 'reload schema';
commit;
