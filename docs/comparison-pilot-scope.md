# Default-empty comparison pilot gate: scope, release and recovery

`20261205000000_comparison_pilot_scope.sql` is a draft, not an activation. It
introduces an empty approved `(website_id, owner_id)` gate for the seven existing
comparison RPCs, preserves every existing nonanonymous owner check, and keeps the
comparison RPCs revoked from `PUBLIC`, `anon` and `authenticated` rather than
granting access. It replaces the seven function bodies only when their expected
source hashes, `SECURITY DEFINER` flags and fixed empty search paths match. It
inserts no approval and does not change `service_role`. A rejected installation
rolls back its changes.

## What the gate does

- `public.comparison_pilot_approved_sites(website_id, owner_id)` is the
  allowlist. RLS is enabled and every privilege is revoked from `PUBLIC`, `anon`,
  `authenticated` and `service_role`. Inherited or `SET ROLE`-reachable
  privileges abort the migration.
- `public.comparison_pilot_site_allowed(uuid)` is a `SECURITY DEFINER` helper
  that locks the approval row and the website row `FOR SHARE`, then returns
  whether the approval's `owner_id` still equals the current website owner. It is
  not granted to any API identity. Because the join uses the current website
  owner, an ownership transfer invalidates the stale pair with no separate
  predicate.
- The seven existing RPCs (`import_independent_audit`,
  `independent_audit_history`, `save_independent_comparison`,
  `independent_comparison_history`, `independent_comparison_detail`,
  `independent_evidence_fingerprint`,
  `delete_independent_audit_evidence`) keep their signatures, return shapes and
  `forbidden` nonanonymous owner checks. Each adds one fail-closed gate check
  immediately after the owner check. The three read RPCs and the fingerprint RPC
  now take the same share lock, so approval removal and ownership transfer wait
  for an in-flight read or write.

## Bounded cleanup

The site-wide `delete_independent_audit_evidence` is unsuitable for assumed-safe
blind deletion: it removes all imports and comparisons for a website after
comparing a site-wide fingerprint. The pilot adds
`public.delete_comparison_pilot_evidence(uuid, uuid[], uuid[], text)`, which is
not granted to any API identity. It:

- requires the same nonanonymous owner and pilot gate;
- takes the website row `FOR UPDATE`, so it serializes with imports, saves,
  approval removal and ownership transfer;
- rejects NULL or duplicate expected identities (`invalid_scope`);
- requires the supplied import and comparison identities to equal the site's
  current evidence exactly (`evidence_scope_mismatch`) and the supplied
  fingerprint to match `independent_evidence_fingerprint`
  (`evidence_changed_export_again`);
- deletes only after those checks, so a mismatch changes nothing.

## How to enable (later, separately reviewed)

This migration defines no operator-facing grant or row. Only a separately
approved administrative identity may insert a `(website_id, owner_id)` pair, and
only a separately reviewed release may grant execute on a comparison RPC.
Before any approval or grant, independently review the identity's permissions,
role membership and credential handling; a user-editable claim, session marker
or UI flag is not authorization. Provisioning must re-verify the exact site,
current owner and the seven held RPCs. Re-running the migration after activation
fails closed on the changed function hashes; a later release needs its own
guard.

## Disable and rollback

`supabase/rollbacks/20261205000000_comparison_pilot_scope_disable.sql` revokes
the seven RPCs from `PUBLIC`/`anon`/`authenticated` and the bounded cleanup from
all API identities and `service_role`, checks membership-reachable effective
denial, and leaves the gate, function bodies, evidence and ledger intact. It is
fail-closed, not an automatic re-enable. A conflicting inherited grant aborts the
transaction. Dropping the gate table or restoring pre-pilot function bodies is a
separate target-specific procedure; the comparison rollback
`20261124000000_independent_audit_comparisons.sql` still refuses to drop nonempty
tables.

## Ledger and guard coordination (integration `t48c`)

This is a new migration-ledger entry after the current staged comparison
migration. Applying it changes the catalog and the public ACL surface, so any
broad same-state guard that assumes the pre-pilot catalog (for example the H04
ledger 45/46 guard's held-ACL and empty-evidence assumptions) must be
re-derived and independently reviewed before or after this migration, never
assumed. The migration's own source-hash guard is narrower than a hosted ledger
guard: it does not prove hosted function ownership, role membership, effective
`SET ROLE` reachability or provider migration atomicity. Integration must
reconcile the ledger order, the guard successor and the single-writer window
with this migration before any hosted application. No ledger, grant, approval or
deployment action is authorized by this document.

## Verification

- `supabase/tests/comparison-pilot-scope.test.mjs` (PGlite) covers guard drift,
  default-empty and inherited-privilege protection, owner/nonowner/anonymous
  denial, every gated RPC after approval, bounded-cleanup mismatch preservation
  and exact deletion, approval removal, ownership transfer, and the fail-closed
  disable.
- `supabase/tests/fixtures/comparison-pilot-scope/concurrency-pg17.py` (PG17)
  covers approval-removal and scoped-cleanup lock serialization, ownership
  transfer and rollback preservation in a disposable container.
- `database.test.mjs` applies the migration on top of the full migration set, and
  the existing `independent-audit.test.mjs` still passes with the gate held.

This is not production verification. The fixtures use synthetic auth helpers and
disposable roles, not hosted Supabase Auth. The web rollout flags and the Fly
deployment are separate release decisions. No hosted grant, approval, import,
save, cleanup, flag or deployment follows from this migration.
