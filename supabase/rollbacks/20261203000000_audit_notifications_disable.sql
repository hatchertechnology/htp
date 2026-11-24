-- Stop and drain all notification workers before running this rollback.
-- Retain queued jobs, events, episodes and delivery history for inspection.
update public.audit_event_config
set enqueue_enabled=false, processing_enabled=false, operations_enabled=false
where singleton;
