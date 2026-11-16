-- PostgREST hoists function settings before its main RPC query. Direct SQL
-- retains the caller's already-running statement timeout. Role defaults stay put.
alter function public.ingest_seosmith_audit(text,uuid,text,text) set statement_timeout = '8s';
alter function public.import_seosmith_audit(uuid,text) set statement_timeout = '8s';
