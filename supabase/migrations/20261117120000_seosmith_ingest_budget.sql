-- Bounded, ingestion-RPC-only budget correction.
--
-- The earlier 8s function budget (20261116233148) was measured against warm,
-- unconstrained local CPU. A valid near-limit token-heavy schema-2 report
-- (15,236,654 raw bytes, ~7.6M-element unrelated root array) needs ~13.6-13.8s
-- on a 0.2-CPU local PostgreSQL 17 / PostgREST 14.18 stack. Hosted ingest was
-- cancelled with SQLSTATE 57014 (query cancellation, consistent with
-- statement_timeout) at ~9.5s, leaving zero rows.
--
-- PostgREST hoists a function's settings before the main RPC query, so this
-- function-scoped setting applies to these two RPCs only. Role defaults,
-- validation, caps, the immutable-audit trigger, authorization and stored
-- bytes are unchanged. The API client deadlines are kept strictly above this
-- budget (worker ingest and owner import use 25s in apps/api/src/websites.rs).
alter function public.ingest_seosmith_audit(text,uuid,text,text) set statement_timeout = '20s';
alter function public.import_seosmith_audit(uuid,text) set statement_timeout = '20s';
