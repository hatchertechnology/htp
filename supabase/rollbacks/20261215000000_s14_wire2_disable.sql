-- Rollback for 20261215000000_s14_wire2.sql: disable the wire-2 validator revision. Idempotent.
-- Capabilities drop wire-2 at once; a new wire-2 commit is validator_disabled; a delivery that is
-- already committed still replays its receipt. Wire-1 is unaffected. Run it only after the thor
-- queue is drained (a pending v2 job would otherwise be rejected). The migration itself stays
-- (inert); the families RPC is revoked separately by R6's revoke-families.sql.
begin;
update public.seosmith_s14_validators set enabled=false where starts_with(revision,'s14-wire-2/');
commit;
